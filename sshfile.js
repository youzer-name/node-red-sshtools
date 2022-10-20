module.exports = function(RED) {
	"use strict";
	const SSHTools = require('./sshtools');
	const os = require("os");
	const path = require('path');
	const iconv = require('iconv-lite');

	function encode(data, enc) {
		if (enc !== "none") {
			return iconv.encode(data, enc);
		}
		return Buffer.from(data);
	}

	function decode(data, enc) {
		if (enc !== "none") {
			return iconv.decode(data, enc);
		}
		return data.toString();
	}


	function ssh_write(config) {
		RED.nodes.createNode(this,config);
		let node = this;

		node.sshccfg = config.sshccfg;
		node.ssh_ctrl = RED.nodes.getNode(this.sshccfg).ssh_ctrl;
		node.filename = config.filename;
		node.overwriteFile = config.overwriteFile.toString();
		node.appendNewline = config.appendNewline;
		node.createDir = config.createDir || false;
		node.encoding = config.encoding || "none";


		let cmdqueue = [];

		let processQueue = function _qcmd(cmdobj) {
			if (node.ssh_ctrl()) {
				switch(cmdobj.cmd) {
				case "delete":
					node.ssh_ctrl().pathdel(cmdobj.path, function(err, fp) {
						if (typeof cmdobj.donefcn === "function") {
							cmdobj.donefcn(err, fp);
						}
						if (cmdqueue.length > 1) {
							setImmediate(function() {
								cmdqueue.shift();
								_qcmd(cmdqueue[0]);
								node.status({});
							});
						} else { cmdqueue.shift(); }
					});
				break;
				case "mkdir":
					node.ssh_ctrl().dirsync(cmdobj.path, { mkdir: true },
							function(err, isExist) {
						if (typeof cmdobj.donefcn === "function") {
							cmdobj.donefcn(err);
						}
						if (cmdqueue.length > 1) {
							setImmediate(function() {
								cmdqueue.shift();
								_qcmd(cmdqueue[0]);
							});
						} else { cmdqueue.shift(); }
				});
				break;
				case "write":
					node.ssh_ctrl().write(cmdobj.path, cmdobj.data,
							{ append: cmdobj.append },
							function(err, fobj) {
						if (typeof cmdobj.donefcn === "function") {
							cmdobj.donefcn(err, fobj);
						}
						if (cmdqueue.length > 1) {
							setImmediate(function() {
								cmdqueue.shift();
								_qcmd(cmdqueue[0]);
							});
						} else { cmdqueue.shift(); }
					});
				break;
				default:
					if (typeof cmdobj.donefcn === "function") {
						cmdobj.donefcn(new Error("Unknown Command"));
					}
				break;
				}
			} else {
				cmdqueue = [];
				node.status({});
			}
		};

		this.on("input", function(msg,nodeSend,done) {
			let filename = node.filename || msg.filename || "";
			let qlen = cmdqueue.length;

			if (!path.isAbsolute(filename)) {
                                node.warn(RED._("sshfile.errors.absolutepath"));
				done();
			} else if (filename === "") {
                                node.warn(RED._("sshfile.errors.nofilename"));
				done();
			} else if (node.overwriteFile === "delete") {
                                if (!node.filename) {
                                        node.status({fill:"grey",shape:"dot",text:filename});
                                }

				let qcnt = cmdqueue.length;
				cmdqueue.push({
					cmd: "delete", path: filename,
					donefcn: function(err) {
						if (err) {
							node.error(RED._("sshfile.errors.deletefail",
									{error:err.toString()}),msg);
						} else {
							node.debug(RED._("sshfile.status.deletedfile",
									{file:filename}));
							nodeSend(msg);
						}
						done();
					}
				});

				if (qcnt === 0) { processQueue(cmdqueue[0]); }
			} else if (msg.hasOwnProperty("payload") &&
				  (typeof msg.payload !== "undefined")) {
				let qcnt = cmdqueue.length;
				let dir = path.dirname(filename);

                                if (!node.filename) {
                                        node.status({fill:"grey",shape:"dot",text:filename});
                                }

				if (node.createDir) {
					cmdqueue.push({
						cmd: "mkdir", path: dir,
						donefcn: function(err) {
							if (err) {
								node.error(RED._("sshfile.errors.createfail",
										{error:err.toString()}),msg);
							}
						}
					});
				}

				let data = msg.payload;
				if (!Buffer.isBuffer(data)) {
					switch(typeof data) {
					case "object":
						data = JSON.stringify(data);
					break;
					case "boolean":
					case "number":
						data = data.toString();
					break;
					default:
					}

					if (node.appendNewline) { data += os.EOL; }
				}

				let buf;
				if (node.encoding === "setbymsg") {
					buf = encode(data, msg.encoding || "none");
				} else { buf = encode(data, node.encoding); }

				cmdqueue.push({
					cmd: "write", path: filename, data: buf,
					append: (node.overwriteFile === "false"),
					donefcn: function(err, fobj) {
						if (err) {
							if (node.overwriteFile === "false") {
								node.error(RED._("sshfile.errors.appendfail",{error:err.toString()}),msg);
							} else {
								node.error(RED._("sshfile.errors.writefail",{error:err.toString()}),msg);
								done();
								return;
							}
						}
						nodeSend(msg);
						done();
					}
				});

				if (qcnt === 0) { processQueue(cmdqueue[0]); }
			} else { done(); }
		});

		node.on('close', function(done) {
                        cmdqueue = [];
                        node.status({});
			done();
		});
	}
	RED.nodes.registerType("sshwrite", ssh_write);

	function ssh_read(config) {
		RED.nodes.createNode(this, config);
		let node = this;

		node.sshccfg = config.sshccfg;
		node.ssh_ctrl = RED.nodes.getNode(this.sshccfg).ssh_ctrl;
		node.filename = config.filename;
		node.format   = config.format;
		node.allProps = config.allProps || false;
		node.encoding = config.encoding || "none";

		if (config.sendError === undefined) {
			node.sendError = true;
        	} else {
			node.sendError = config.sendError;
		}

		if (node.format === "lines") { node.chunk = true; }
		else if (node.format === "stream") { node.chunk = true; }

		let cmdqueue = [];

                let processQueue = function _qcmd(cmdobj) {
                        if (node.ssh_ctrl()) {
				cmdobj.paramobj = {};
				node.ssh_ctrl().read(cmdobj.path, {}, function(err, fobj) {
                                	if (typeof cmdobj.donefcn === "function") {
                                        	cmdobj.donefcn(err, fobj, cmdobj.paramobj);
                                        }
					if (err || (fobj.bytesread === fobj.filesize)) {
	                                        if (cmdqueue.length > 1) {
	                                        	setImmediate(function() {
	                                        	    cmdqueue.shift();
	                                                    _qcmd(cmdqueue[0]);
	                                                    node.status({});
	                                                });
	                                        } else { cmdqueue.shift(); }
					}
				});
			} else {
				cmdqueue = [];
                                node.status({});
			}
		}


		this.on("input", function(msg,nodeSend,done) {
                        let filename = (node.filename || msg.filename || "").replace(/\t|\r|\n/,'');;
                        let qlen = cmdqueue.length;

			if (!path.isAbsolute(filename)) {
				node.warn(RED._("sshfile.errors.absolutepath"));
                                done();
                        } else if (filename === "") {
				node.warn(RED._("sshfile.errors.nofilename"));
                                done();
                        } else {
				if (!node.filename) {
					node.status({fill:"grey",shape:"dot",text:filename});
				}

				msg.filename = filename;
				let ch = "";
				let type = "buffer";
				if (node.format === "lines") {
					ch = "\n";
					type = "string";
				}

				cmdqueue.push({
					path: filename,
					donefcn: function(err, fobj, tmpobj) {
						if (err) {
							node.error(err, msg);
							if (node.sendError) {
								let sendmsg = RED.util.cloneMessage(msg);
								delete sendmsg.payload;

								sendmsg.error = err;
								nodeSend(sendmsg);
							}
							done();
							return;
						}

						if (typeof tmpobj.lines === "undefined") {
							tmpobj.lines = Buffer.from([]);
							tmpobj.spare = "";
							tmpobj.count = 0;
						}

						if (node.chunk) {
							if (node.format === "lines") {
								tmpobj.spare += decode(fobj.data, node.encoding);

								let bits = tmpobj.spare.split("\n");
								let i = 0;
								for (i=0; i < bits.length-1; i++) {
									let m = {};
									if (node.allProps) {
										m = RED.util.cloneMessage(msg);
									} else {
										m.topic = msg.topic;
										m.filename = msg.filename;
									}
									m.payload = bits[i];
									m.parts = { index:tmpobj.count, ch:ch, type:type, id:msg._msgid};
									tmpobj.count += 1;
									nodeSend(m);
								}

								if (fobj.bytesread === fobj.filesize) {
									let m = {};
									if (node.allProps) {
										m = RED.util.cloneMessage(msg);
									} else {
										m.topic = msg.topic;
										m.filename = msg.filename;
									}

									m.payload = bits[i];
									m.parts = {
										index: tmpobj.count,
										count: tmpobj.count + 1,
										ch: ch,
										type: type,
										id: msg._msgid
									};
									nodeSend(m);
									done();
								} else { tmpobj.spare = bits[i]; }
							} else if (node.format === "stream") {
								let m = {};
								if (node.allProps == true) {
									m = RED.util.cloneMessage(msg);
								} else {
									m.topic = msg.topic;
									m.filename = msg.filename;
								}
								m.payload = fobj.data;
								m.parts = {index:tmpobj.count, ch:ch, type:type, id:msg._msgid};
								tmpobj.count += 1;

								if (fobj.bytesread === fobj.filesize) {
									m.parts.count = tmpobj.count;
									nodeSend(m);
									done();
								} else {
									nodeSend(m);
								}
							}
						} else {
							tmpobj.lines = Buffer.concat([tmpobj.lines,fobj.data]);
							if (fobj.bytesread === fobj.filesize) {
								if (node.format === "utf8") {
									msg.payload = decode(tmpobj.lines, node.encoding);
								} else { msg.payload = tmpobj.lines; }
								nodeSend(msg);
								done();
							}
						}
					}
				});

				if (qlen === 0) processQueue(cmdqueue[0]);
			}
		});

		node.on('close', function(done) {
			node.status({});
			done();
		});
	}
	RED.nodes.registerType("sshread", ssh_read);
}
