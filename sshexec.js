module.exports = function(RED) {
	"use strict";

	const SSHTools = require('./sshtools');

	function ssh_exec(config) {
		RED.nodes.createNode(this, config);
		let node = this;

		node.sshccfg = config.sshccfg;
		node.ssh_ctrl = RED.nodes.getNode(this.sshccfg).ssh_ctrl;
		node.cmd = (config.command || "").trim();

		if (config.addpay === undefined) { config.addpay = true; }
		node.addpay = config.addpay;

		if (node.addpay === true) { node.addpay = "payload"; }

		node.append = (config.append || "").trim();
		node.useSpawn = (config.useSpawn == "true");
		node.timer = Number(config.timer || 0)*1000;
		node.sigint = config.sigint || false;

		let activeProcesses = [];

		let spawnCommand = function _scmd(cmdobj) {
			if (node.ssh_ctrl()) {
				node.ssh_ctrl().spawn(cmdobj.arg, cmdobj.param,
							function(err, stream) {
					let nxtfcn = function() {
						if (activeProcesses.length > 1) {
							setImmediate(function() {
								activeProcesses.shift();
								_scmd(activeProcesses[0]);
								node.status({fill:"blue",shape:"dot",text:"sshexec.label.executing"});
							});
						} else { activeProcesses.shift(); }
					};

					if (err) {
						cmdobj.msg.payload = err.code;
						node.status({fill:"red",shape:"dot",text:"error:"+err.code});
						cmdobj.msgsend([null, null, RED.util.cloneMessage(cmdobj.msg)]);
						nxtfcn();
						return;
					}

					cmdobj.killexec = stream.killexec || function() {};

					stream.on('data', function(data) {
						if (SSHTools.isUtf8(data)) cmdobj.msg.payload = data.toString();
						else cmdobj.msg.payload = data;
						cmdobj.msgsend([
							RED.util.cloneMessage(cmdobj.msg),
							null, null
						]);
					}).on('close', function(code, signal) {
						cmdobj.msg.payload = { code:code };
						cmdobj.msg.signal = signal;
						if (code === 0) { node.status({}); }
						else if (signal) { node.status({fill:"red",shape:"dot",text:"sshexec.label.killed"}); }
						else { node.status({fill:"red",shape:"dot",text:"error:"+code}); }
						cmdobj.msgsend([null, null,
							RED.util.cloneMessage(cmdobj.msg)
						]);
						nxtfcn();
					}).on('error', function(code) {
						node.status({fill:"red",shape:"dot",text:"error:"+code});
						nxtfcn();
					}).stderr.on('data', function(data) {
						if (SSHTools.isUtf8(data)) cmdobj.msg.payload = data.toString();
						else cmdobj.msg.payload = data;
						cmdobj.msgsend([null,
							RED.util.cloneMessage(cmdobj.msg),
							null
						]);
					});
				});
			} else {
				activeProcesses = [];
				node.status({});
			}
		};

		let processCommand = function _pcmd(cmdobj) {
			if (node.ssh_ctrl()) {
				node.ssh_ctrl().exec(cmdobj.arg, cmdobj.param,
							function (err, stdout, stderr) {
					let msg = cmdobj.msg, msg2 = null, msg3 = null;

					delete msg.payload;

					if (stderr) {
						msg2 = RED.util.cloneMessage(msg);
						msg2.payload = stderr;
					}

					msg.payload = Buffer.from(stdout,"binary");
					if (SSHTools.isUtf8(msg.payload)) { msg.payload = msg.payload.toString(); }
					//msg.payload = (typeof stdout != "string")?"":stdout;
					node.status({});

					msg3 = RED.util.cloneMessage(msg);
					if (err) {
						msg3.payload = {code:err.code, message:err.message};
						if (err.signal) { msg3.payload.signal = err.signal; }
						if (err.code === null) { node.status({fill:"red",shape:"dot",text:"sshexec.label.killed"}); }
						else { node.status({fill:"red",shape:"dot",text:"error:"+err.code}); }
						node.debug('error:' + err.message);
					} else { msg3.payload = {code:0}; }

					if (!msg3) { node.status({}); }
					else {
						msg.rc = msg3.payload;
						if (msg2) { msg2.rc = msg3.payload; }
					}

					cmdobj.msgsend([msg, msg2, msg3]);

					if (activeProcesses.length > 1) {
						setImmediate(function() {
							activeProcesses.shift();
							_pcmd(activeProcesses[0]);
							node.status({fill:"blue",shape:"dot",text:"sshexec.label.executing"});
						});
					} else { activeProcesses.shift(); }
				});
			} else {
				activeProcesses = [];
				node.status({});
			}
		}

		node.on('input', function(msg, nodeSend, nodeDone) {
			if (node.ssh_ctrl()) {
				if (msg.hasOwnProperty("kill")) {
					if (activeProcesses.length > 0) {
						if (activeProcesses[0].killexec) {
							activeProcesses[0].killexec(node.sigint);
						}
					}
				} else {
					let arg = node.cmd;
					let paramobj = {};

					if (node.timer > 0) paramobj["timeout"] = node.timer;
					if (node.sigint) paramobj["pty"] = true;

					if (node.addpay) {
						let value = RED.util.getMessageProperty(msg, node.addpay);
						if (value !== undefined) arg += " " + value;
					}

					if (node.append.trim() !== "") { arg += " " + node.append; }

					node.debug(arg);
					node.status({fill:"blue",shape:"dot",text:"sshexec.label.executing"});

					if (activeProcesses.length > 0) {
						activeProcesses.push({
							arg: arg, param: paramobj,
							msg: msg, msgsend: nodeSend
						});
					} else {
						activeProcesses.push({
							arg: arg, param: paramobj,
							msg: msg, msgsend: nodeSend
						});
						if (node.useSpawn) {
							spawnCommand(activeProcesses[0]);
						} else { processCommand(activeProcesses[0]); }
					}
				}
			} else { node.status({}); }
			nodeDone();
		});

		node.on("close", function(done) {
			activeProcesses = [];
			node.status({});
			done();
		});
	}
	RED.nodes.registerType("sshexec", ssh_exec);
}
