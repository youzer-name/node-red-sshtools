module.exports = function(RED) {
	"use strict";
	const SSHTools = require('./sshtools');

	let nrloglvl = RED.settings.logging.console.level;

	function ssh_conncfg(config) {
		RED.nodes.createNode(this, config);
		let node = this;
		let _sshobj = null;

		let _logfcn = function(txt) { }
		if (nrloglvl === "info" || nrloglvl === "debug" || nrloglvl === "trace") {
			_logfcn = function(txt) { RED.log.info("["+node.name+":"+node.id+"] " + txt); }
		}

		let _sshconfig = {
			host: config.sshhost,
			port: config.sshport,
			keepaliveInterval: config.keeptime,
			keepaliveCountMax: config.keepcount,
         		connLog: _logfcn
		};

		if (config.persist) {
			_sshconfig.keepaliveInterval = config.keeptime;
			_sshconfig.keepaliveCountMax = config.keepcount;
		}

		if (node.credentials) {
			if (node.credentials.hasOwnProperty("keydata")) {
				_sshconfig.privatekey = node.credentials.keydata;
			}

			if (_sshconfig.privatekey && node.credentials.hasOwnProperty("passphrase")) {
				_sshconfig.passphrase = node.credentials.passphrase;
			}

			if (node.credentials.hasOwnProperty("password")) {
				_sshconfig.password = this.credentials.password;
				_sshconfig.tryKeyboard = true;
			}

			if (_sshconfig.password && node.credentials.hasOwnProperty("userid")) {
				_sshconfig.username = node.credentials.userid;
			}
		}

		try {
			_sshobj = new SSHTools(_sshconfig);

			node.ssh_ctrl = function() { return _sshobj; }

			node.on('close', function(done) {
				node.ssh_ctrl().end(true);
				done();
			});
		} catch(err) {
			node.warn("ssh-conncfg: " + err);
			if (node.ssh_ctrl()) {
				node.ssh_ctrl().end();
			}
		}
	};
	RED.nodes.registerType("ssh-conncfg", ssh_conncfg, {
                credentials: {
                        keydata: { type: "text" },
                        passphrase: { type: "password" },
                        userid: { type: "text" },
                        password: { type: "password" }
                }
	});
}
