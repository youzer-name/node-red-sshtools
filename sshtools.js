"use strict";

const SSH2 = require('ssh2');
const util = require('util');
const path = require('path');
const tls = require('tls');
//var JSON2 = require('./json2');

function _isUtf8(bytes) {
	var i = 0;
	while(i < bytes.length) {
		if((bytes[i] == 0x09 || bytes[i] == 0x0A ||
		   bytes[i] == 0x0D || (0x20 <= bytes[i] && bytes[i] <= 0x7E))) {
			i += 1;
			continue;
		}
		if(((0xC2 <= bytes[i] && bytes[i] <= 0xDF) &&
		   (0x80 <= bytes[i+1] && bytes[i+1] <= 0xBF))) {
			i += 2;
			continue;
		}
		if((bytes[i] == 0xE0 &&
		   (0xA0 <= bytes[i + 1] && bytes[i + 1] <= 0xBF) &&
		   (0x80 <= bytes[i + 2] && bytes[i + 2] <= 0xBF)) ||
		   (((0xE1 <= bytes[i] && bytes[i] <= 0xEC) ||
		   bytes[i] == 0xEE || bytes[i] == 0xEF) &&
		   (0x80 <= bytes[i + 1] && bytes[i+1] <= 0xBF) &&
		   (0x80 <= bytes[i+2] && bytes[i+2] <= 0xBF)) ||
		   (bytes[i] == 0xED &&
		   (0x80 <= bytes[i+1] && bytes[i+1] <= 0x9F) &&
		   (0x80 <= bytes[i+2] && bytes[i+2] <= 0xBF))) {
			i += 3;
			continue;
		}
		if((bytes[i] == 0xF0 &&
		   (0x90 <= bytes[i + 1] && bytes[i + 1] <= 0xBF) &&
		   (0x80 <= bytes[i + 2] && bytes[i + 2] <= 0xBF) &&
		   (0x80 <= bytes[i + 3] && bytes[i + 3] <= 0xBF)) ||
		   ((0xF1 <= bytes[i] && bytes[i] <= 0xF3) &&
		   (0x80 <= bytes[i + 1] && bytes[i + 1] <= 0xBF) &&
		   (0x80 <= bytes[i + 2] && bytes[i + 2] <= 0xBF) &&
		   (0x80 <= bytes[i + 3] && bytes[i + 3] <= 0xBF)) ||
		   (bytes[i] == 0xF4 &&
		   (0x80 <= bytes[i + 1] && bytes[i + 1] <= 0x8F) &&
		   (0x80 <= bytes[i + 2] && bytes[i + 2] <= 0xBF) &&
		   (0x80 <= bytes[i + 3] && bytes[i + 3] <= 0xBF))) {
			i += 4;
			continue;
		}
		return false;
	}
	return true;
}


function SSHTools(cfg) {
	if (!(this instanceof SSHTools)) return new SSHTools();

	let self = this;

	this._sshcfg = {
		host: cfg.host || "127.0.0.1",
		port: cfg.port || "22",
		keepaliveInterval: cfg.keepaliveInterval || 60000,
		keepaliveCountMax: cfg.keepaliveCountMax || 1,
		readyTimeout: cfg.readyTimeout || 20000,
		connectTimeout: cfg.connectTimeout || 30000,
		username: cfg.username,
		password: cfg.password,
		privatekey: cfg.privatekey,
		tryKeyboard: true,
		logging: cfg.connLog || console.log
	};

	this._sshLog = this._sshcfg.logging || function(txt) { };

	this._sshconn = null;
	this._sshdisabled = false;
	this._cmdqueue = [];
}

function _tagStream(self, stream) {
	let new_sid = 0;
	let found_stream = null;
	do {
		new_sid = (1+Math.random()*4294967295);
		found_stream = self.findStream(new_sid);
	} while(found_stream);

	if (stream) stream.sid = new_sid;

	return stream;
};


function _isconnected(connobj) {
	return ( connobj
		&& connobj._sock
		&& connobj._sock.writable
		&& connobj._sock._readableState
		&& connobj._sock._readableState.ended === false);
}

function _logoff(self) {
	if (self._sshdisabled) {
		self.end();
		return;
	}

	if (self._sshconn) {
		if (self._sshconn.sshtimeout) return;
		const chnls = Object.keys(self._sshconn._chanMgr._channels);
		const svrs = Object.keys(self._sshconn._forwarding);
		if ((chnls.length == 0) && (svrs.length == 0)) {
			//self._sshLog("Starting shutdown of connection to SSH server " + self._sshcfg.host + ":" + self._sshcfg.port);
			self._sshconn.sshtimeout = setTimeout(function() {
				if (self._sshconn) {
					const chnls = Object.keys(self._sshconn._chanMgr._channels);
					const svrs = Object.keys(self._sshconn._forwarding);
					if ((chnls.length == 0) && (svrs.length == 0)){
						self._sshLog("Disconnecting from SSH server " + self._sshcfg.host + ":" + self._sshcfg.port);
						self.end();
					} else { self._sshconn.sshtimeout = null; }
				}
			}, self._sshcfg.connectTimeout);
		}
	}
}


function _buildtunnel(self) {
	while(self._cmdqueue.length > 0) {
		let cmdobj = self._cmdqueue.shift();
		switch(cmdobj.type) {
		case "TCPIN":
		try {
			self._sshLog("Creating tunnel IN " + cmdobj.param.host + ":" + cmdobj.param.port);
			self._sshconn.forwardIn(cmdobj.param.host, cmdobj.param.port, function(err, port) {
				cmdobj.rdyfcn(err, null);
				if (err) _logoff(self);
			});
		} catch(e) {
			cmdobj.rdyfcn(e,null);
			_logoff(self);
		}
		break;
		case "TCPOUT":
		try {
			self._sshLog("Creating tunnel OUT " + cmdobj.param.host + ":" + cmdobj.param.port);
			self._sshconn.forwardOut("127.0.0.1", 0, cmdobj.param.host, cmdobj.param.port,
						function(err, stream) {
				if (err) {
					if (stream) stream.end();
					cmdobj.rdyfcn(err, null);
					_logoff(self);
					return;
				}

				stream.rHost = cmdobj.param.host;
				stream.rPort = cmdobj.param.port;
				stream.lHost = "127.0.0.1";
				stream.lPort = 0;
				stream.tlsSock = null;
				_tagStream(self, stream);

				if (cmdobj.param.tls) {
					cmdobj.param.tls.socket = stream;
					cmdobj.param.tls.rejectUnauthorized = false;
					stream.tlsSock = tls.connect(cmdobj.param.tls);
					stream.tlsSock.on("secureConnect", function() {
						stream.tlsSock.rHost = stream.rHost;
						stream.tlsSock.rPort = stream.rPort;
						stream.tlsSock.lHost = stream.lHost;
						stream.tlsSock.lPort = stream.lPort;
						stream.tlsSock.sid = stream.sid;
						cmdobj.rdyfcn(null, stream.tlsSock);
					}).on("end", function() {
						stream.end();
					}).on("error", function(terr) {
                        if (stream.tlsSock && !stream.tlsSock.rHost) {
                            cmdobj.rdyfcn(terr, null);
                        }
                        stream.end();
                    });
				}

				stream.on("data", function(data) {
					/* Required to recieve end & close correctly */
				}).on("end", function() {
					stream.end();
				}).on("close", function() {
					self._sshLog("Close tunnel OUT " + stream.rHost + ":" + stream.rPort);
					stream.close();
					if (stream.tlsSock) {
						stream.tlsSock.end();
						stream.tlsSock = null;
					}
					stream.destroy();
					_logoff(self);
				});

				if (!stream.tlsSock) cmdobj.rdyfcn(null, stream);
			});
		} catch(e) {
			cmdobj.rdyfcn(e,null);
			_logoff(self);
		}
		break;
		case "EXEC":
		try {
			self._sshconn.exec(cmdobj.param.cmd, cmdobj.param, function(err, stream) {
				if (err) {
					if (stream) stream.end();
					if (typeof cmdobj.rdyfcn === "function") {
						cmdobj.rdyfcn({
							"code": err.errno,
							"message": err.message,
							"signal": undefined
						}, "", "");
					}
					_logoff(self);
					return;
				}

				_tagStream(self, stream);
				stream.rHost = "CMD";
				stream.rPort = 0;
				stream.lHost = "CMD";
				stream.lPort = 0;
				stream.rdyfcn = cmdobj.rdyfcn;

				stream.sessobj = {
					cmd: cmdobj.param.cmd,
					param: cmdobj.param,
					stdout: [], stderr: []
				};

				stream.killexec = function(sigtype) {
					if (sigtype) { stream.write("\x03");
					} else { stream.signal("SIGTERM"); }
				};

				if (typeof cmdobj.param.timeout === "number") {
					stream.cmdtimeout = setTimeout(function(stm) {
						if (stm.sessobj.param["pty"]) {
							stm.write("\x03");
						} else { stm.signal("SIGTERM"); }
					}, cmdobj.param.timeout, stream);
				}

				if (cmdobj.param.spawn) {
					if (typeof cmdobj.rdyfcn === "function")
						cmdobj.rdyfcn(err, stream);

					stream.on('close', function(code, signal) {
						clearTimeout(stream.cmdtimeout);
						stream.end();
						_logoff(self);
					});
				} else {
					stream.on('close', function(code, signal) {
						let errobj = null;
						let outstr = Buffer.concat(stream.sessobj.stdout);
						let errstr = Buffer.concat(stream.sessobj.stderr);

						if (_isUtf8(outstr)) { outstr = outstr.toString(); }
						if (_isUtf8(errstr)) { errstr = errstr.toString(); }

						if ((code != 0) || signal) {
							errobj = {
								"code": code,
								"signal": signal,
								"message": "Command failed: " + stream.sessobj.cmd
							};
							if (typeof code === "number") errobj.message = errstr;
						}

						if ((typeof stream.rdyfcn === "function")) {
							stream.rdyfcn(errobj, outstr, errstr);
						}

						clearTimeout(stream.cmdtimeout);
						stream.end();
						_logoff(self);
					}).on('end', function() {
						clearTimeout(stream.cmdtimeout);
						stream.end();
					}).on('data', function(data) {
						stream.sessobj.stdout.push(data);
					}).stderr.on('data', function(data) {
						stream.sessobj.stderr.push(data);
					});
				}
			});
		} catch(e) {
			cmdobj.rdyfcn(e, null);
			_logoff(self);
		}
		break;
		case "SFTP":
 		try {
			self._sshconn.sftp(function(err, sftp) {
				if (err) {
					if (sftp) sftp.end();
					cmdobj.rdyfcn(err, null);
					_logoff(self);
					return;
				}

				_tagStream(self, sftp);
				sftp.rHost = "CMD";
				sftp.rPort = 0;
				sftp.lHost = "CMD";
				sftp.lPort = 0;
				sftp.rdyfcn = cmdobj.rdyfcn;

                		_sftpcmd(self, sftp, cmdobj);
			});
		} catch(e) {
			cmdobj.rdyfcn(e, null);
			_logoff(self);
		}
		break;
        default:
		}
	}
}

function _sftpcmd(self, sftp, cmdobj) {
    switch(cmdobj.param.cmd) {
    case "pwd":
        sftp.realpath(".", function(err, absPath) {
            sftp.rdyfcn(err, absPath);
            sftp.end();
            _logoff(self);
        });
    break;
    case "delete":
        sftp.stat(cmdobj.param.path, function(err, stats) {
            if (err) {
                sftp.rdyfcn(err, {});
                sftp.end();
                _logoff(self);
                return;
            }

            if (stats.isDirectory()) {
                sftp.rmdir(cmdobj.param.path, function(err) {
                    sftp.rdyfcn(err, cmdobj.param.path);
                    sftp.end();
                    _logoff(self);
                });
            } else {
                sftp.unlink(cmdobj.param.path, function(err) {
                    sftp.rdyfcn(err, cmdobj.param.path);
                    sftp.end();
                    _logoff(self);
                });
            }
        });
    break;
    case "read":
        sftp.open(cmdobj.param.path, "r", function(err_a, fd) {
            if (err_a) {
                sftp.rdyfcn(err_a, {});
                sftp.end();
                _logoff(self);
                return;
            }

            sftp.fstat(fd, function(err_b, stats) {
                if (err_b) {
                    sftp.rdyfcn(err_b, {});
                    sftp.close(fd);
                    sftp.end();
                    _logoff(self);
                    return;
                }

                let fsize = stats.size,
                    fbuffer = Buffer.alloc(fsize),
                    chunksize = 16384,
                    byteidx = 0,
                    fdone = false;

                while((byteidx < fsize) && !fdone) {
                    if ((byteidx + chunksize) > fsize) chunksize = fsize - byteidx;
                    sftp.read(fd, fbuffer, byteidx, chunksize, byteidx, _rdfunc);
                    byteidx += chunksize;
                }

                let totalBytesRead = 0;
                function _rdfunc(err_c, bytecnt, buf, pos) {
                    if (err_c) {
                        fdone = true;
                        sftp.rdyfcn(err_c, {});
                        sftp.close(fd);
                        sftp.end();
                        _logoff(self);
                        return;
                    }
                    totalBytesRead += bytecnt;
                    sftp.rdyfcn(null, {
                        data: fbuffer.slice(pos, pos+bytecnt),
                        position: pos,
                        bytesread: totalBytesRead,
                        filesize: fsize
                    });
                    if (totalBytesRead === fsize) {
			sftp.close(fd);
			sftp.end();
			setTimeout(function() { _logoff(self); }, 10);
		    }
                }

                if (fsize === 0) sftp.rdyfcn(null, {
                    data: Buffer.alloc(0),
                    position: 0,
                    bytesread: 0,
                    filesize: 0
                });
            });
        });
    break;
    case "write":
        sftp.open(cmdobj.param.path, cmdobj.param.append?"a":"w", function(err_a, fd) {
            if (err_a) {
                sftp.rdyfcn(err_a, {});
                sftp.end();
                _logoff(self);
                return;
            }

            sftp.fstat(fd, function(err_b, stats) {
                if (err_b) {
                    sftp.rdyfcn(err_b, {});
                    sftp.close(fd);
                    sftp.end();
                    _logoff(self);
                    return;
                }

                let fsize = stats.size,
                    chunksize = 16384,
                    wbyteidx = fsize;

                function _wrpath(fbuffer) {
                    if (chunksize > fbuffer.length) chunksize = fbuffer.length;
                    sftp.write(fd, fbuffer, 0, chunksize, wbyteidx, function (err_c) {
                        if (err_c) {
                            sftp.rdyfcn(err_c, {});
                            sftp.close(fd);
                            sftp.end();
                            _logoff(self);
                            return;
                        }
                        wbyteidx += chunksize;
                        if (fbuffer.length > chunksize) {
                            _wrpath(fbuffer.slice(chunksize));
                        }
                        sftp.rdyfcn(null, {
                            data: fbuffer,
                            position: wbyteidx,
                            filesize: fsize,
                            finished: (fbuffer.length <= chunksize)
                        });

			if (fbuffer.length <= chunksize) {
				sftp.close(fd);
				sftp.end();
				setTimeout(function() { _logoff(self); }, 10);
			}
                    });
                }
                if (Buffer.isBuffer(cmdobj.param.data)) {
                    _wrpath(Buffer.from(cmdobj.param.data));
                } else {
                    sftp.rdyfcn(new Error("No Data Buffer"), {});
                    sftp.close(fd);
                    sftp.end();
                    _logoff(self);
                }
            });
        });
    break;
    case "dirsync":
	let dirs = cmdobj.param.path.split("/");
	let walker = [dirs.shift()];

	function _wlkpath(dr, wlkr, create) {
	    if (dr.length > 0) {
		wlkr.push(dr.shift());
		let pstr = wlkr.join("/");

		sftp.stat(pstr, function(err, stats) {
		    if (err) {
                        if (err.message === "No such file" && create) {
			    sftp.mkdir(pstr, function(ecode) {
                                if (ecode) {
				    sftp.rdyfcn(err);
                                    sftp.end();
                                    _logoff(self);
				} else {
                                    _wlkpath(dirs, walker, create);
                                }
                            });
                        } else {
                            sftp.rdyfcn(err);
                            sftp.end();
                            _logoff(self);
                        }
                    } else {
                        if (stats.isDirectory()) {
				_wlkpath(dirs, walker, create);
			} else {
				sftp.rdyfcn(new Error("File exists"));
                                sftp.end();
                                _logoff(self);
			}
                    }
		});
	    } else {
            	sftp.rdyfcn(null, true);
                sftp.end();
                _logoff(self);
            }
        };
        _wlkpath(dirs, walker, cmdobj.param.mkdir?true:false);
    break;
    case "stat":
            sftp.stat(cmdobj.param.path, function(err, stats) {
                sftp.rdyfcn(err, stats);
                sftp.end();
                _logoff(self);
            });
    break;
    default:
        sftp.rdyfcn(new Error("Command does not exist"), null);
        sftp.end();
        _logoff(self);
    }
}


function _clearcmd(self, e) {
	if (self._sshconn) {
		while(self._cmdqueue.length > 0) {
			let cmdobj = self._cmdqueue.shift();
			cmdobj.rdyfcn(e,null);
		}
	}
}

function _retrycall(self, err) {
	if (self._sshconn && !self._sshdisabled) {
		const chnls = self._sshconn._chanMgr._channels || {};
		for (const property in chnls) {
			if (chnls[property].type === "direct-tcpip") {
				if (typeof chnls[property].emit === "function") {
					chnls[property].emit("ssh_error", err);
				}
			}
		}

		for (const property in self._sshconn._forwarding) {
			let ch = self._sshconn.listening[property];
			if (ch) {
				if (typeof ch.rtryfcn === "function") {
					ch.rtryfcn(err);
				}
			}
		}
	}
}

SSHTools.prototype.tunnelOpen = function(type, param, rdyfcn) {
	let self = this;

	if (self._sshdisabled) return;

	self._cmdqueue.push({
		"type": type,
		"param": param,
		"rdyfcn": rdyfcn
	});

	try {
		if (self._sshconn) {
			clearTimeout(self._sshconn.sshtimeout);
			self._sshconn.sshtimeout = null;

			if (_isconnected(self._sshconn) && (!self._sshconn.sshconnecting)) {
				_buildtunnel(self);
			} else if (!self._sshconn.sshconnecting) {
				self._sshLog("Connection out of sync closing");
				self.end();
			}
		}

		if (self._sshconn == null) {
			self._sshconn = new SSH2.Client();
			self._sshconn.sshconnecting = true;
			self._sshconn.sshtimeout = null;
			self._sshconn.listening = {};

			self._sshLog("Connecting to SSH server " + self._sshcfg.host + ":" + self._sshcfg.port);

			self._sshconn.on("ready", function() {
				self._sshLog("Connected to SSH server " + self._sshcfg.host + ":" + self._sshcfg.port);
				self._sshconn.sshconnecting = false;
				self._sshconn._sock.setKeepAlive(true, self._sshcfg.connectTimeout*2);
				_buildtunnel(self);
			}).on("end", function() {
				self._sshLog("Ending Connection to SSH server "+self._sshcfg.host+":"+self._sshcfg.port);
				_clearcmd(self, new Error('SSH Connection Ending'));
				if (self._sshconn) { self._sshconn.end(); }
			}).on("close", function(had_error) {
				self._sshLog("Closing Connection to SSH server "+self._sshcfg.host+":"+self._sshcfg.port);
				let errobj = (had_error?had_error:new Error('SSH Connection Closing'));
				_clearcmd(self, errobj);
				_retrycall(self, errobj);
				self.end();
			}).on("error", function(e) {
				self._sshLog("Connection Error("+self._sshcfg.host+":"+self._sshcfg.port + "):" + e);
				_clearcmd(self, e);
				_retrycall(self, e);
				self.end();
			}).on("keyboard-interactive", function(name, descr, lang, prompts, finish) {
				if (self._sshconn) return finish([self._sshcfg.password]);
				else return finish([""]);
			}).on('tcp connection', function(info, accept, reject) {
				if (self._sshconn) {
					let isfound = false;
					for (const property in self._sshconn._forwarding) {
						if (property === (info.destIP + ":" + info.destPort)) {
							let cfcn = self._sshconn.listening[property].tcpfcn;
                            				if (typeof cfcn === "function") {
								let stream = null;
								if (self._sshconn.listening[property].tls) {
									isfound = true;
									stream = accept();
									if (stream) {
										stream.rHost = info.srcIP;
										stream.rPort = info.srcPort;
										stream.lHost = info.destIP;
										stream.lPort = info.destPort;
										_tagStream(self, stream);

										self._sshconn.listening[property].tls.rejectUnauthorized = false;
                                        self._sshconn.listening[property].tls.isServer = true;
										stream.tlsSock = new tls.TLSSocket(stream,
												self._sshconn.listening[property].tls);

    										stream.tlsSock.on("secure", function() {
											    cfcn(info, function() {
												    stream.tlsSock.rHost = stream.rHost;
												    stream.tlsSock.rPort = stream.rPort;
												    stream.tlsSock.lHost = stream.lHost;
												    stream.tlsSock.lPort = stream.lPort;
												    stream.tlsSock.sid = stream.sid;
												    return stream.tlsSock;
											    }, function() {
											    	stream.end();
												    stream = null;
											    });
										    }).on("error", function(terr) {
                                                self._sshLog("Server Error("+property+"):" + terr);
                                                stream.end();
										    }).on("end", function() {
											    stream.end();
										    });

										    stream.on("data", function(data) {
										        // Required to recieve end & close correctly
										    }).on("end", function() { 
											    stream.end();
                                            }).on("error", function(serr) {
                                                //self._sshLog("Server Error("+property+"):" + serr);
										    }).on("close", function() {
											    stream.close();
											    if (stream.tlsSock) {
												    stream.tlsSock.end();
												    stream.tlsSock = null;
											    }
											    stream.destroy();
										    });
                                    }
								} else {
									cfcn(info, function() {
										isfound = true;
										stream = accept();
										stream.rHost = info.srcIP;
										stream.rPort = info.srcPort;
										stream.lHost = info.destIP;
										stream.lPort = info.destPort;
										return _tagStream(self, stream);
									}, reject);

									if (stream) {
										stream.on("data", function(data) {
											// Required to recieve end & close correctly
										}).on("end", function() { stream.end();
										}).on("close", function() {
											stream.close();
											stream.destroy();
										});
									} else { reject(); }
								}
							} else { reject(); }
						}
					}
                    if (!isfound) reject();
                } else { reject(); }
            }).connect(self._sshcfg);
        }
	} catch(err) {
		_clearcmd(self, err);
		_retrycall(self, err);
		self.end();
	}
};

SSHTools.prototype.tunnelListen = function(param, tcpfcn) {
	let self = this;
	if (self._sshconn && (typeof tcpfcn === "function")) {
		let isfound = false;
		for (const property in self._sshconn._forwarding) {
			if (property === (param.host + ":" + param.port)) {
				self._sshLog("Listening on tunnel IN " + param.host + ":" + param.port);
				isfound = true;

				self._sshconn.listening[property] = {
					"tcpfcn": tcpfcn,
					"rtryfcn": (param.rtryfcn?param.rtryfcn:null)
				}

				if (param.tls) {
					param.tls.isServer = true;
					self._sshconn.listening[property].tls = param.tls;
				}
			}
        	}
	}
};

SSHTools.prototype.tunnelClose = function(type, param, donefcn) {
	let self = this;

	if (self._sshconn) {
		switch(type) {
		case "TCPIN":
			let isfound = false;
			for (const property in self._sshconn._forwarding) {
				if (property === (param.host + ":" + param.port)) {
					isfound = true;
					self._sshLog("Closing tunnel IN " + param.host + ":" + param.port);
					try {
						delete self._sshconn.listening[property];
						self._sshconn.unforwardIn(param.host, param.port, function() {
							if (self._sshconn) {
								const chnls = self._sshconn._chanMgr._channels;
								for (const property in chnls) {
									if ((chnls[property].type === "forwarded-tcpip") &&
											(chnls[property].lHost === param.host) &&
											(chnls[property].lPort === param.port)) {
										if (chnls[property].tlsSock) {
											chnls[property].tlsSock.end();
											chnls[property].tlsSock = null;
										}
										chnls[property].end();
									}
								}
							}
							if (typeof donefcn === "function") donefcn();
							_logoff(self);
						});
					} catch(err) {
						self.end();
						if (typeof donefcn === "function") donefcn();
					}
				}
			}
			if (!isfound && (typeof donefcn === "function")) donefcn();
        	break;
        	case "TCPOUT":
			const chnls = self._sshconn._chanMgr._channels;
			for (const property in chnls) {
				if ((chnls[property].type === "direct-tcpip") &&
						(chnls[property].rHost === param.host) &&
						(chnls[property].rPort === param.port)) {
					self._sshLog("Closing tunnel OUT " + param.host + ":" + param.port);
					if (chnls[property].tlsSock) {
						chnls[property].tlsSock.end();
						chnls[property].tlsSock = null;
					}
					chnls[property].end();
					if (typeof donefcn === "function") donefcn();
				}
			}
		break;
		default:
			if (typeof donefcn === "function") donefcn();
		}
	} else if (typeof donefcn === "function") donefcn();
	_logoff(self);
};

SSHTools.prototype.findStream = function(sid) {
	let self = this;

	if (self._sshconn) {
		const chnls = self._sshconn._chanMgr._channels;
		if (typeof sid === "number") {
			for (const property in chnls) {
				if (chnls[property].sid === sid) {
					if (chnls[property].tlsSock) return chnls[property].tlsSock;
					else return chnls[property];
				}
			}
		} else if (typeof sid === "string") {
			const itm = sid.split("@");
			if (itm.length >= 2) {
				for (const property in chnls) {
					if ((chnls[property].rHost == itm[0]) &&
							(chnls[property].rPort == itm[1])) {
						if (chnls[property].tlsSock) return chnls[property].tlsSock;
						else return chnls[property];
					}
				}
			}
		}
	}
	return null;
};

SSHTools.prototype.broadcast = function(id, cbfcn) {
	let self = this;

	if (self._sshconn && (typeof cbfcn === "function")) {
		const chnls = self._sshconn._chanMgr._channels;
		if (typeof id === "number") {
			for (const property in chnls) {
				if ((chnls[property].type === "forwarded-tcpip" || chnls[property].type === "direct-tcpip") &&
						chnls[property].sid === sid) {
					if (chnls[property].tlsSock) cbfcn(chnls[property].tlsSock);
					else cbfcn(chnls[property]);
					return;
				}
			}
		} else if (typeof id === "string") {
			const itm = id.split("@");
			if (itm.length >= 2) {
				for (const property in chnls) {
					if ((chnls[property].type === "forwarded-tcpip") &&
							(chnls[property].lHost == itm[0]) &&
							(chnls[property].lPort == itm[1])) {
						if (chnls[property].tlsSock) cbfcn(chnls[property].tlsSock);
						else cbfcn(chnls[property]);
					}
				}
			}
		} else {
			for (const property in chnls) {
				if (chnls[property].type === "forwarded-tcpip" || chnls[property].type === "direct-tcpip") {
					if (chnls[property].tlsSock) cbfcn(chnls[property].tlsSock);
					else cbfcn(chnls[property]);
				}
			}
		}
	}
};

SSHTools.prototype.exec = function(cmd, param, rdyfcn) {
	let self = this;

	let pobj = ((typeof param === "object")?param:{});
	pobj.cmd = cmd;

	self.tunnelOpen("EXEC", pobj, rdyfcn);
};

SSHTools.prototype.spawn = function(cmd, param, rdyfcn) {
	let self = this;

	let pobj = ((typeof param === "object")?param:{});
	pobj.cmd = cmd;
	pobj.spawn = true;

	self.tunnelOpen("EXEC", pobj, rdyfcn);
};

SSHTools.prototype.read = function(path, param, rdyfcn) {
    let self = this;

    let pobj = ((typeof param === "object")?param:{});
    pobj.cmd = "read";
    pobj.path = path;

    self.tunnelOpen("SFTP", pobj, rdyfcn);
};


SSHTools.prototype.write = function(path, data, param, rdyfcn) {
    let self = this;

    let pobj = ((typeof param === "object")?param:{});
    pobj.cmd = "write";
    pobj.path = path;
    pobj.data = data;

    self.tunnelOpen("SFTP", pobj, rdyfcn);
};

SSHTools.prototype.dirsync = function(path, param, rdyfcn) {
    let self = this;

    let pobj = ((typeof param === "object")?param:{});
    pobj.cmd = "dirsync";
    pobj.path = path;

    self.tunnelOpen("SFTP", pobj, rdyfcn);
};

SSHTools.prototype.pathdel = function(path, rdyfcn) {
    let self = this;

    let pobj = ((typeof param === "object")?param:{});
    pobj.cmd = "delete";
    pobj.path = path;

    self.tunnelOpen("SFTP", pobj, rdyfcn);
};

SSHTools.prototype.end = function(dable) {
	let self = this;

	if (dable) self._sshdisabled = true;

	if (self._sshconn) {
		const llist = self._sshconn.listening;
		for (const property in llist) {
			llist[property].rtryfcn = function() { };
		}
		if (self._sshconn._sock) self._sshconn._sock.setTimeout(0);
		clearTimeout(self._sshconn.sshtimeout);
		self._sshconn.end();
		self._sshconn.destroy();
		self._sshconn = null;
		self._cmdqueue = [];
	}
};

SSHTools.prototype.parseFloat = function(string, radix) {
	if ((typeof string === "string") && (typeof radix === "number")) {
		//split the string at the decimal point
		string = string.split(/\./);

		//if there is nothing before the decimal point, make it 0
		if (string[0] == '') { string[0] = "0"; }

		//if there was a decimal point & something after it
		if (string.length > 1 && string[1] != '') {
			let fractionLength = string[1].length;
			string[1] = parseInt(string[1], radix);
			string[1] *= Math.pow(radix, -fractionLength);
			return parseInt(string[0], radix) + string[1];
		}

		//if there wasn't a decimal point or there was but nothing was after it
		return parseInt(string[0], radix);
	}
	return 0.0;
};

SSHTools.isUtf8 = _isUtf8;

module.exports = SSHTools;
