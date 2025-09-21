module.exports = function(RED) {
    "use strict";
    const SSHTools = require('./sshtools');

    function makeLogger(node, config) {
        // Pull global console logging level from settings.js
        const globalLevel = RED.settings.logging?.console?.level || "info";

        // Effective behavior
        const override = config.logLevel && config.logLevel.trim() !== "" ? config.logLevel : null;

        return function _logfcn(msg) {
            if (override === "none") {
                // Explicitly disabled
                return;
            }
            if (override === "info") {
                // Always log as info
                node.log(msg);
                return;
            }

            // Default: follow global Node-RED log level
            const levels = ["fatal", "error", "warn", "info", "debug", "trace"];
            if (levels.indexOf("info") <= levels.indexOf(globalLevel)) {
                node.log(msg);
            }
        };
    }

    function ssh_conncfg(config) {
        RED.nodes.createNode(this, config);
        let node = this;
        let _sshobj = null;

        // ✅ Create logger for this node
        let _logfcn = makeLogger(node, config);

        let _sshconfig = {
            host: config.sshhost,
            port: config.sshport,
            keepaliveInterval: config.keeptime,
            keepaliveCountMax: config.keepcount,
            connLog: _logfcn   // ✅ Pass in logger
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

            node.ssh_ctrl = function() { return _sshobj; };

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
    }

    RED.nodes.registerType("ssh-conncfg", ssh_conncfg, {
        credentials: {
            keydata: { type: "text" },
            passphrase: { type: "password" },
            userid: { type: "text" },
            password: { type: "password" }
        }
    });
};
