module.exports = function(RED) {
	"use strict";
        const reconnectTime = RED.settings.socketReconnectTime||10000;
	const SSHTools = require('./sshtools');

	function sshtun_in(config) {
		RED.nodes.createNode(this, config);
		let node = this;

		node.host = config.host;
		node.port = config.port * 1;
		node.topic = config.topic;
		node.stream = (!config.datamode||config.datamode=="stream");
		node.datatype = config.datatype||"buffer";
		node.newline = (config.newline||"").replace("\\n","\n").replace("\\r","\r");
		node.rtype = config.rtype||"server";
		node.sshccfg = config.sshccfg;
		node.ssh_ctrl = RED.nodes.getNode(this.sshccfg).ssh_ctrl;
		node.closing = false;
		node.connected = false;
		node.tls = config.tls;
		if (node.tls) node.tlsNode = RED.nodes.getNode(node.tls);

		let _svrcount = 0;
		let _svractive = false;
		let _rdyfcn = null;
		let reconnectTimeout;
		let fastconnect = false;

		let _setupStream = function(stream, issvr) {
			let buffer = (node.datatype == 'buffer') ? Buffer.alloc(0) : "";

			if (issvr) {
				node.status({ text:RED._("sshtun.state.connections", {count:_svrcount}),
						event:"connect",
						ip:stream.rHost,
						port:stream.rPort,
						_session: { type: "ssh", id: stream.sid.toString(16) }
				});
			} else {
				node.connected = true;
				node.status({fill:"green",shape:"dot",text:"sshtun.state.connected"});
			}

			stream.on("data", function(data) {
				if (node.datatype != "buffer") {
					data = data.toString(node.datatype)
				}

				if (node.stream) {
					let msg;
					if ((typeof data) === "string" && node.newline !== "") {
						buffer = buffer+data;
						let parts = buffer.split(node.newline);
						for (let i = 0; i < parts.length-1; i+=1) {
							msg = { topic: node.topic, payload:parts[i] };
							if (issvr) {
								msg.ip = stream.rHost;
								msg.port = stream.rPort;
							}
							msg._session = { type: "ssh", id: stream.sid.toString(16) };
							node.send(msg);
						}
						buffer = parts[parts.length-1];
					} else {
						msg = { topic: node.topic, payload: data };
						if (issvr) {
							msg.ip = stream.rHost;
							msg.port = stream.rPort;
						}
						msg._session = { type: "ssh", id: stream.sid.toString(16) };
						node.send(msg);
					}
				} else {
					if ((typeof data) === "string") {
						buffer = buffer+data;
					} else {
						buffer = Buffer.concat([buffer,data],buffer.length+data.length);
					}
				}
			}).on('end', function() {
				if (!node.stream || (node.datatype == "utf8" && node.newline !== "")) {
					if (buffer.length > 0) {
						let msg = { topic: node.topic, payload: buffer };
						if (issvr) {
							msg.ip = stream.rHost;
							msg.port = stream.rPort;
						} else fastconnect = true;
						msg._session = { type: "ssh", id: stream.sid.toString(16) };
						node.send(msg);
					}
					buffer = null;
				}
			}).on('close', function() {
					if (issvr) {
						_svrcount--;
						if (_svractive) {
							node.status({text: RED._("sshtun.state.connections", {count: _svrcount}),
								event: "disconnect",
								ip: stream.rHost,
								port: stream.rPort,
								_session: {type: "ssh", id: stream.sid.toString(16)}
							});
						}
					} else {
						node.connected = false;
						node.status({fill:"red",shape:"ring",text:"sshtun.state.disconnected"});
						if (!node.closing) {
							if (fastconnect) {
								fastconnect = false;
								reconnectTimeout = setTimeout(function () {
									node.status({fill:"grey",shape:"dot",text:"sshtun.state.connecting"});
									let connOpts = { "host": node.host, "port": node.port };
									if (node.tls) { connOpts.tls = node.tlsNode.addTLSOptions({}); }
									if (node.ssh_ctrl()) node.ssh_ctrl().tunnelOpen("TCPOUT", connOpts, _rdyfcn);
								}, 20);
							} else {
								node.log(RED._("sshtun.errors.connection-reconnect", {host:node.host, port:node.port}));
								node.status({fill:"grey",shape:"dot",text:"sshtun.state.connecting"});
								reconnectTimeout = setTimeout(function () {
									let connOpts = { "host": node.host, "port": node.port };
									if (node.tls) { connOpts.tls = node.tlsNode.addTLSOptions({}); }
									if (node.ssh_ctrl()) node.ssh_ctrl().tunnelOpen("TCPOUT", connOpts, _rdyfcn);
								}, reconnectTime);
							}
						} else {
							if (node.doneClose) {
								node.status({});
								node.closing = false;
								node.doneClose();
							}
						}
					}
			}).on('error', function(err) {
				if (issvr) node.warn(err + " <tunnelIn:error>");
				else node.warn(err + " <tunnelOut: "+ stream.rHost + "@" + stream.rPort +">");
			}).on('ssh_error', function(err) {
				if (issvr) node.warn(err + " <tunnelIn:ssh_error>");
				else node.warn(err + " <tunnelOut: "+ stream.rHost + "@" + stream.rPort +">");
			});

		};

		if (node.rtype === "client") {
			let buffer = null;
			let sid = ""+node.host+"@"+node.port;

			if (node.ssh_ctrl()) {
				node.status({fill:"grey",shape:"dot",text:"sshtun.state.connecting"});
				_rdyfcn = function(err, stream) {
					if (err) {
						if (!node.closing) {
							reconnectTimeout = setTimeout(function () {
								node.status({fill:"grey",shape:"dot",text:"sshtun.state.connecting"});
								let connOpts = { "host": node.host, "port": node.port };
								if (node.tls) { connOpts.tls = node.tlsNode.addTLSOptions({}); }
								if (node.ssh_ctrl()) node.ssh_ctrl().tunnelOpen("TCPOUT", connOpts, _rdyfcn);
							}, reconnectTime);
						}
						node.status({fill:"red",shape:"ring",text:"sshtun.state.disconnected"});
						node.log(err + " <tunnelOut: "+ sid +">");
						return;
					}
					clearTimeout(reconnectTimeout);
					_setupStream(stream, false);

				};

				let connOpts = { "host": node.host, "port": node.port };
				if (node.tls) { connOpts.tls = node.tlsNode.addTLSOptions({}); }
				node.ssh_ctrl().tunnelOpen("TCPOUT", connOpts, _rdyfcn);
				node.log(RED._("sshtun.status.create-tunnel", {host:node.host, port:node.port}));

			} else { node.status({}); }

			node.on('close', function(done) {
				node.doneClose = done;
				node.closing = true;

				clearTimeout(reconnectTimeout);

				if (node.ssh_ctrl()) {
					node.ssh_ctrl().tunnelClose("TCPOUT", { "host": node.host, "port": node.port });
				}

				node.log(RED._("sshtun.status.closing-tunnel", {host:node.host, port:node.port}));

				if (!node.connected) {
					node.status({});
					done();
				}
			});
		} else {
			/* Server */
			if (node.ssh_ctrl()) {
				node.status({fill:"grey",shape:"dot",text:"sshtun.state.initializing"});
				node.ssh_ctrl().tunnelOpen("TCPIN", { "host": "localhost", "port": node.port },  function _inrdyfcn(err) {
					if (err) {
						if (!node.closing) {
							reconnectTimeout = setTimeout(function () {
								node.status({fill:"grey",shape:"dot",text:"sshtun.state.initializing"});
								if (node.ssh_ctrl()) node.ssh_ctrl().tunnelOpen("TCPIN", { "host": "localhost", "port": node.port }, _inrdyfcn);
                                                	}, reconnectTime);
						}
						node.status({fill:"red",shape:"ring",text:"sshtun.state.failed"});
						node.warn(err + " <tunnelIn>");
						return;
					} else {

						clearTimeout(reconnectTimeout);
						_svractive = true;
						node.status({text: RED._("sshtun.state.connections", {count: _svrcount})});

						node.log(RED._("sshtun.status.serving-tunnel", {port:node.port}));

						if (node.ssh_ctrl()) node.ssh_ctrl().tunnelListen({ "host":"localhost", "port": node.port,
						"tls": (node.tls?node.tlsNode.addTLSOptions({}):undefined),
						"rtryfcn": function(e) {
							if (!node.closing) {
								reconnectTimeout = setTimeout(function () {
									node.status({fill:"grey",shape:"dot",text:"sshtun.state.initializing"});
									if (node.ssh_ctrl()) node.ssh_ctrl().tunnelOpen("TCPIN", { "host": "localhost", "port": node.port }, _inrdyfcn);
                                                		}, reconnectTime);
							}
							node.status({fill:"red",shape:"ring",text:"sshtun.state.failed"});
							node.warn(RED._("sshtun.errors.failed-listening", {port:node.port, err:e}));
							return;
						}}, function(info, accept, reject) {
							if (node.closing) {
								reject();
								return null;
							} else {
								let stream = accept();
								_svrcount++;
								_setupStream(stream, true);
								return stream;
							}
						});
					}
				});

				node.on('close', function(done) {
					_svractive = false;
					node.closing = true;
					node.log(RED._("sshtun.status.stopping-tunnel", {port:node.port}));

					node.status({});

					clearTimeout(reconnectTimeout);

					_svrcount = 0;
					if (node.ssh_ctrl()) {
						node.ssh_ctrl().tunnelClose("TCPIN", { "host": "localhost", "port": node.port }, function() {
							done();
						});
					} else {
						done();
					}
				});
			}
		}

	}
	RED.nodes.registerType("sshtun-in", sshtun_in);

	function sshtun_out(config) {
		RED.nodes.createNode(this, config);
		let node = this;

		node.host = config.host;
		node.port = config.port * 1;
		node.rtype = config.rtype||"server";
		node.base64 = config.base64;
		node.doend = config.end || false;
		node.sshccfg = config.sshccfg;
		node.ssh_ctrl = RED.nodes.getNode(this.sshccfg).ssh_ctrl;
		node.closing = false;
		node.connected = false;
		node.tls = config.tls;
		if (node.tls) node.tlsNode = RED.nodes.getNode(node.tls);

		let reconnectTimeout = null;

		if (node.rtype == "client") {
			let sid = ""+node.host+"@"+node.port;
			let fastconnect = false;

			if (node.ssh_ctrl()) {
				node.status({fill:"grey",shape:"dot",text:"sshtun.state.connecting"});
				let _rdyfcn = function (err, stream) {
					if (err) {
						if (!node.closing) {
							reconnectTimeout = setTimeout(function () {
								node.status({fill:"grey",shape:"dot",text:"sshtun.state.connecting"});
								let connOpts = { "host": node.host, "port": node.port };
								if (node.tls) { connOpts.tls = node.tlsNode.addTLSOptions({}); }
								if (node.ssh_ctrl()) node.ssh_ctrl().tunnelOpen("TCPOUT", connOpts, _rdyfcn);
							}, reconnectTime);
						}
						node.status({fill:"red",shape:"ring",text:"sshtun.state.disconnected"});
						node.log(err + " <tunnelOut: " + sid + ">");
						return;
					}

					clearTimeout(reconnectTimeout);

					stream.rHost = node.host;
					stream.rPort = node.port;

					node.status({fill:"green",shape:"dot",text:"sshtun.state.connected"});
					node.connected = true;

					stream.on("end", function() {
						node.connected = false;
						node.status({});
					}).on("close", function() {
						node.connected = false;
						node.status({fill:"red",shape:"ring",text:"sshtun.state.disconnected"});
						if (!node.closing) {
							if (fastconnect) {
								fastconnect = false;
								reconnectTimeout = setTimeout(function () {
									node.status({fill:"grey",shape:"dot",text:"sshtun.state.connecting"});
									let connOpts = { "host": node.host, "port": node.port };
									if (node.tls) { connOpts.tls = node.tlsNode.addTLSOptions({}); }
									if (node.ssh_ctrl()) node.ssh_ctrl().tunnelOpen("TCPOUT", connOpts, _rdyfcn);
								}, 20);
							} else {
								node.log(RED._("sshtun.errors.connection-reconnect", {host:node.host, port:node.port}));
								reconnectTimeout = setTimeout(function () {
									node.status({fill:"grey",shape:"dot",text:"sshtun.state.connecting"});
									let connOpts = { "host": node.host, "port": node.port };
									if (node.tls) { connOpts.tls = node.tlsNode.addTLSOptions({}); }
									if (node.ssh_ctrl()) node.ssh_ctrl().tunnelOpen("TCPOUT", connOpts, _rdyfcn);
								}, reconnectTime);
							}
						} else {
							if (node.doneClose) {
								node.status({});
								node.closing = false;
								node.doneClose();
							}
						}
					}).on("error", function(e) {
						node.warn(e + " <tunnelOut: " + sid + ">");
					}).on('ssh_error', function(err) {
						node.warn(err + " <tunnelOut: "+ sid +">");
					});
				};
				let connOpts = { "host": node.host, "port": node.port };
				if (node.tls) { connOpts.tls = node.tlsNode.addTLSOptions({}); }
				node.ssh_ctrl().tunnelOpen("TCPOUT", connOpts, _rdyfcn);

			} else { node.status({}); }

			node.on("input", function(msg,nodeSend,nodeDone) {
				if (node.connected && msg.payload != null && node.ssh_ctrl()) {
					let stream = node.ssh_ctrl().findStream(sid);

					if (stream != null && stream.writable) {
						if (Buffer.isBuffer(msg.payload)) {
							stream.write(msg.payload, 'utf8');
						} else if (typeof msg.payload === "string" && node.base64) {
							stream.write(Buffer.from(msg.payload, 'base64'));
						} else {
							stream.write(Buffer.from(""+msg.payload),'utf8');
						}

						if (node.doend === true) {
							node.status({});
							fastconnect = true;
							stream.end();
						}
					}
				}
				nodeDone();
			});

			node.on('close', function(done) {
				node.doneClose = done;
				node.closing = true;

				clearTimeout(reconnectTimeout);

				if (node.ssh_ctrl()) {
					node.ssh_ctrl().tunnelClose("TCPOUT", { "host": node.host, "port": node.port });
				}

				node.log(RED._("sshtun.status.closing-tunnel", {host:node.host, port:node.port}));

				if (!node.connected) {
					node.status({});
					done();
				}
			});

		} else if (node.rtype == "reply") {

			node.on("input", function(msg, nodeSend, nodeDone) {
				if (msg._session && msg._session.type == "ssh" && node.ssh_ctrl()) {
					let snum = node.ssh_ctrl().parseFloat(msg._session.id, 16);
					let oldStream = node.ssh_ctrl().findStream(snum);
					if (oldStream != null && oldStream.writable) {
						if (Buffer.isBuffer(msg.payload))
							oldStream.write(msg.payload, 'utf8');
						else if (typeof msg.payload === "string" && node.base64)
							oldStream.write(Buffer.from(msg.payload,'base64'));
						else
							oldStream.write(Buffer.from(""+msg.payload), 'utf8');
					}
				} else if (node.ssh_ctrl()) {
					node.ssh_ctrl().broadcast(null, function(stream) {
						if (stream != null && stream.writable) {
							if (Buffer.isBuffer(msg.payload))
								stream.write(msg.payload, 'utf8');
							else if (typeof msg.payload === "string" && node.base64)
								stream.write(Buffer.from(msg.payload,'base64'));
							else
								stream.write(Buffer.from(""+msg.payload), 'utf8');
						}
					});
				}
				nodeDone();
			});

		} else {
			/* Server */
			let _svrcount = 0;
			let _svractive = false;

			if (node.ssh_ctrl()) {
				node.status({fill:"grey",shape:"dot",text:"sshtun.state.initializing"});
				node.ssh_ctrl().tunnelOpen("TCPIN", { "host": "localhost", "port": node.port }, function _inrdyfcn(err) {
					if (err) {
						if (!node.closing) {
							reconnectTimeout = setTimeout(function () {
								node.status({fill:"grey",shape:"dot",text:"sshtun.state.initializing"});
								if (node.ssh_ctrl()) node.ssh_ctrl().tunnelOpen("TCPIN", { "host": "localhost", "port": node.port }, _inrdyfcn);
                                                	}, reconnectTime);
						}
						node.status({fill:"red",shape:"ring",text:"sshtun.state.failed"});
						node.warn(err + " <tunnelIn>");
						return;
					} else {

						clearTimeout(reconnectTimeout);
						_svractive = true;
						node.status({text: RED._("sshtun.state.connections", {count: _svrcount})});

						node.log(RED._("sshtun.status.serving-tunnel", {port:node.port}));
						node.ssh_ctrl().tunnelListen({ "host": "localhost", "port": node.port,
						"tls": (node.tls?node.tlsNode.addTLSOptions({}):undefined),
						"rtryfcn": function(e) {
							if (!node.closing) {
								reconnectTimeout = setTimeout(function () {
									node.status({fill:"grey",shape:"dot",text:"sshtun.state.initializing"});
									if (node.ssh_ctrl()) node.ssh_ctrl().tunnelOpen("TCPIN", { "host": "localhost", "port": node.port }, _inrdyfcn);
                                                		}, reconnectTime);
							}
							node.status({fill:"red",shape:"ring",text:"sshtun.state.failed"});
							node.warn(RED._("sshtun.errors.failed-listening", {port:node.port, err:e}));
							return;
						}}, function(info, accept, reject) {
							if (node.closing) {
								reject();
								return null;
							} else {
								let stream = accept();
								_svrcount++;

								node.status({text:RED._("sshtun.state.connections",{count: _svrcount})});

								stream.on('close', function() {
									_svrcount--;
									if (_svrcount < 0) _svrcount = 0;
									if (_svractive) {
										node.status({text:RED._("sshtun.state.connections",{count: _svrcount})});
									}
								}).on('error', function(err) {
									node.warn(err + " <tunnelIn>");
								}).on('ssh_error', function(err) {
									node.warn(err + " <tunnelIn>");
								});

								return stream;
							}
						});
					}
				});

				node.on('close', function(done) {
					_svractive = false;
					node.closing = true;
					node.log(RED._("sshtun.status.stopping-tunnel", {port:node.port}));

					node.status({});

					clearTimeout(reconnectTimeout);

					_svrcount = 0;
					if (node.ssh_ctrl()) {
						node.ssh_ctrl().tunnelClose("TCPIN", { "host": "localhost", "port": node.port }, function() {
							done();
						});
					} else {
						done();
					}
				});
			}

			node.on('input', function(msg, nodeSend, nodeDone) {
				if (msg.payload != null && node.ssh_ctrl()) {
					let buffer;

					if (Buffer.isBuffer(msg.payload)) {
						buffer = msg.payload;
					} else if (typeof msg.payload === "string" && node.base64) {
						buffer = Buffer.from(msg.payload, 'base64');
					} else {
						buffer = Buffer.from("" + msg.payload, 'utf8');
					}

					node.ssh_ctrl().broadcast("localhost@"+ node.port, function(stream) {
						if (stream != null && stream.writable) {
							stream.write(buffer);
							if (node.doend === true) { stream.end() };
						}
					});
				}
				nodeDone();
			});

		}

	}
	RED.nodes.registerType("sshtun-out", sshtun_out);

	function sshtun_req(config) {
		RED.nodes.createNode(this, config);
		let node = this;
		node.server = config.server;
		node.port = Number(config.port);
		node.out = config.out;
		node.ret = config.ret || "buffer";
		node.newline = (config.newline||"").replace("\\n","\n").replace("\\r","\r").replace("\\t","\t");
		node.splitc = config.splitc;
		node.sshccfg = config.sshccfg;
		node.ssh_ctrl = RED.nodes.getNode(this.sshccfg).ssh_ctrl;
		node.tls = config.tls;
		if (node.tls) node.tlsNode = RED.nodes.getNode(node.tls);

		//time, char, count, sit, immed

		let clients = {};

		if (node.out === "immed") { node.splitc = -1; node.out = "time"; }
		if (node.out !== "char") { node.splitc = Number(this.splitc); }
		else {
			if (node.splitc == '\\') {
				node.splitc = parseInt(node.splitc.replace("\\n", 0x0A).
								replace("\\r", 0x0D).
								replace("\\t", 0x09).
								replace("\\e", 0x1B).
								replace("\\f", 0x0C).
								replace("\\0", 0x00));
			}

			if (typeof node.splitc == "string") {
				if (node.splitc.substr(0,2) == "0x") {
					node.splitc = parseInt(node.splitc);
				} else {
					node.splitc = node.splitc.charCodeAt(0);
				}
			}
		}

		node.on('input', function(msg, nodeSend, nodeDone) {
			if (node.ssh_ctrl()) {
				let i = 0;
				if (!msg.payload) msg.payload = "";

				if((!Buffer.isBuffer(msg.payload)) && (typeof msg.payload !== "string")) {
					msg.payload = msg.payload.toString();
				}

				let cli_host = node.server || msg.host;
				let cli_port = node.port || msg.port;

				let sid = cli_host + "@" + cli_port;
				if (sid !== node.last_id) {
					node.status({});
					node.last_id = sid;
				}

				if (msg.hasOwnProperty("disconnect") && msg.payload.length < 1) {
					nodeDone();
					if (!clients[sid] || (!clients[sid].connecting &&
					    !clients[sid].connected)) { return; }
				}

				clients[sid] = clients[sid] || {
					msgQueue: [],
					connected: false,
					connecting: false
				};

				clients[sid].msgQueue.push({
					msg:msg,
					nodeSend:nodeSend,
					nodeDone: nodeDone
				});

				clients[sid].lastMsg = msg;

				if (!clients[sid].connecting && !clients[sid].connected) {
					let buf = Buffer.alloc(0);
					clients[sid].stream = null;

					if (cli_host && cli_port) {
						clients[sid].connecting = true;

						let connOpts = { "host": cli_host, "port": cli_port };
						if (node.tls) { connOpts.tls = node.tlsNode.addTLSOptions({}); }
						node.ssh_ctrl().tunnelOpen("TCPOUT", connOpts, function(err, stream) {
							if (err) {
								node.status({fill:"red",shape:"ring",text:"sshtun.state.error"});
								if (clients[sid]) clients[sid].connecting = false;
								node.warn(err + " <tunnelout: " + sid + ">");
								return;
							}

							if (!clients[sid]) {
								stream.end();
								node.log(RED._("sshtun.errors.missingclient", {host:cli_host, port:cli_port}));
								return;
							}

							node.status({fill:"green", shape:"dot", text:"sshtun.state.connected"});
							clients[sid].connected = true;
							clients[sid].connecting = false;
							clients[sid].stream = stream;

							let chunk = "";
							stream.on('data', function(data) {
								if (clients[sid]) {
									buf = Buffer.concat([buf, data]);
									switch(node.out) {
									// Keep Connection Open
									case "sit":
										if (clients[sid]) {
											const msg = clients[sid].lastMsg || {};
											msg.payload = RED.util.cloneMessage(data);
											if (node.ret === "string") {
												try {
													if (node.newline && node.newline !== "") {
														chunk += msg.payload.toString();
														let parts = chunk.split(node.newline);
														for(let p=0; p<parts.length-1; p+=1) {
															let m = RED.util.cloneMessage(msg);
															m.payload = parts[p] + node.newline.trimEnd();
															nodeSend(m);
														}
														chunk = parts[parts.length-1];
													} else {
														msg.payload = msg.payload.toString();
														nodeSend(msg);
													}
												} catch(e) { node.error(RED._("sshtun.errors.bad-string"), msg); }
											} else { nodeSend(msg); }
										}
										buf = Buffer.alloc(0);
									break;
									// Connection Close on Time
									case "time":
										if (!clients[sid].timeout) {
											clients[sid].timeout = setTimeout(function() {
												if (clients[sid]) {
													clients[sid].timeout = null;
													const msg = clients[sid].lastMsg || {};
													msg.payload = Buffer.alloc(buf.length);
													buf.copy(msg.payload,0,0,buf.length);
													if (node.ret === "string") {
														try { msg.payload = msg.payload.toString(); }
														catch(e) { node.error("Failed to create string", msg); }
													}
													nodeSend(msg);
													if (clients[sid].stream) {
														node.status({});
														clients[sid].stream.end();
													}
													clients[sid].closing = true;
												}
												buf = Buffer.alloc(0);
											}, node.splitc);
										}
									break;
									// Connection Close on character count received
									case "count":
										if (buf.length >= node.splitc) {
											const msg = clients[sid].lastMsg || { };
											msg.payload = Buffer.alloc(node.splitc);
											buf.copy(msg.payload,0,0,node.splitc);
											if (node.ret === "string") {
                                                try { msg.payload = msg.payload.toString(); }
                                                catch(e) { node.error("Failed to create string", msg); }
                                            }
											nodeSend(msg);
											if (clients[sid].stream) {
												node.status({});
												clients[sid].stream.end();
											}
											clients[sid].closing = true;
											buf = Buffer.alloc(0);
										}
									break;
									default:
										let cidx = buf.indexOf(node.splitc);
										if (cidx >= 0) {
											const msg = clients[sid].lastMsg || { };
											msg.payload = Buffer.alloc(cidx+1);
											buf.copy(msg.payload,0,0,cidx);
											if (node.ret === "string") {
                                                try { msg.payload = msg.payload.toString(); }
                                                catch(e) { node.error("Failed to create string", msg); }
                                            }
											nodeSend(msg);
											if (clients[sid].stream) {
												node.status({});
												clients[sid].stream.end();
											}
											clients[sid].closing = true;
											buf = Buffer.alloc(0);
										}
									}
								}
							}).on('error', function() {
								node.status({fill:"red",shape:"ring",text:"sshtun.state.error"});
								if (clients[sid]) {
									if (clients[sid].stream) clients[sid].stream.end();
									delete clients[sid];
								} else { stream.end(); }
							}).on('end', function() {
								node.status({fill:"grey", shape:"ring", text:"sshtun.state.disconnected"});
								if (clients[sid]) {
									clients[sid].connected = false;
									clients[sid].connecting = false;
									clients[sid].stream = null;
								}
							}).on('close', function() {
								if (clients[sid]) {
									clients[sid].connected = false;
									clients[sid].connecting = false;
								}

								let anyConnected = false;
								for (let client in clients) {
									if (clients[client].connected) {
										anyConnected = true;
										break;
									}
								}

								if (node.doneClose && !anyConnected) {
									clients = {};
									node.doneClose;
								}
							}).on('timeout', function() {
								
							}).on('ssh_error', function(err) {
								node.warn(err + " <tunnelout: " + sid + ">");
							});

							let dflag = false;
							let event;
							while(event = clients[sid].msgQueue.shift()) {
								if (event.msg.hasOwnProperty("disconnect")) dflag = true;
								if (event.msg.payload.length > 0) {
									stream.write(event.msg.payload);
								}
								event.nodeDone();
							}

							// Close right after sending
							if (((node.out === "time") && (node.splitc < 0)) || dflag) {
								clients[sid].connected = false;
								clients[sid].connecting = false;
								stream.end();
								delete clients[sid];
								node.status({});
							}
						});
					}
				} else if (!clients[sid].connecting && clients[sid].connected) {
					let dflag = false;
					if (clients[sid] && clients[sid].stream) {
						let event = clients[sid].msgQueue.shift();
						if (event.msg.hasOwnProperty("disconnect")) dflag = true;
						if (event.msg.payload.length > 0) {
							clients[sid].stream.write(event.msg.payload);
						}
						event.nodeDone();
                                	}

					if (dflag) {
						clients[sid].connected = false;
						clients[sid].connecting = false;
						clients[sid].stream.end();
						delete clients[sid];
						node.status({});
					}
				}
			}
		});

		node.on("close", function(done) {
			node.doneClose = done;

			for (let cl in clients) {
				if (clients[cl].hasOwnProperty("stream")) {
					if (clients[cl].stream) clients[cl].stream.end();
				}
			}

			node.status({});

			let anyConnect = false;
			for (let c in clients) {
				if (clients[c].connected) {
					anyConnected = true;
					break;
				}
			}

			if (!anyConnected) { clients = {}; }

			done();
		});
	}
	RED.nodes.registerType("sshtun-req", sshtun_req);
}
