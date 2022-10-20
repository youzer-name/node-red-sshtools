@arcsoft/node-red-sshtools
=======================

A <a href="http://nodered.org" target="_new">Node-RED</a> set of nodes that will connect to SSH server
and provide TCP like communication nodes, remote execution, and file read/write operations.

Install
-------

Run the following command in your Node-RED user directory - typically `~/.node-red`

        npm install @arcsoft/node-red-sshtools

Usage
-----

###ssh-conncfg

Configuration for a connection to an SSH Server.

This configuration will create a single connection to an SSH server which can then be used by `sshtun-in`, `sshtun-out`, `sshtun-req` and other nodes.

The node will open a SSH control connection that will be used to tunnel all the streams of data through.
Host & Port

This is the host/ip and the Port to which to authenticate with.

**Private Key Authentication**

A key file can be uploaded which will be used during the private key exchange authentication process. If left blank this process will be ignored and account authentication will need to be used. A field for a passphrase can be used if the key file provided has been password protected.
Account Authentication

The account authentication is used to provide username or password for the remote user account that will be used to login. If left blank the private key authentication will need to be used.

**Enable connection keep-alive**

When enabled the SSH-level keep-alive messages will be sent to the server/host. The interval will be used to determine how often to send these messages. While the max count will determine how many unanswered messages are sent before the connection is terminated.



### sshtun-in

A SSH Tunnel in node provides a choice of inputs. Can either connect to a remote TCP port, or accept incoming connections.

The output type can be a single message or a stream of data. When the single message is selected the node will wait for the client to disconnect before sending the message.

The output types can be a Buffer, String, or Base64 string. This will be what the payload will be encoded as.

Details of about the client will be added as properties of the message.

**Note:** On some systems you may need root or administorator access to ports below 1024. Also some SSH servers will only allow binding reverse tunnels to localhost interfaces



##sshtun-out

A SSH Tunnel out node provides a choice of outputs. Can either connect to a remote TCP port, or accept incoming connections.

Only the msg.payload is sent.

If `msg.payload` is a string containing Base64 encoding of binary data, the Base64 decoding option will cause it to be converted back to binary before being sent.

If `msg._session` is not present the payload is sent to **all** connected streams (tunnel nodes) under the control of the SSH Configuration Node (`ssh-conncfg`)

**Note:** On some systems you may need root or administrator access to ports below 1024. Also some SSH servers will only allow binding reverse tunnels to localhost interfaces



###sshtun-req

A SSH Tunnel request node - sends the `msg.payload` to a server tcp port and expects a response.

**Inputs**
`payload` (*string | buffer*)
    The data send as part of the request.
`host` (*string*)
    The hostname or IP address of the remote host to send the request.
`port` (*number*)
    The port of the remote host to send the request.
`disconnect` (*boolean*)
    A flag to tell the node to disconnect after sending payload.

**Details**

Connects, sends the "request", and reads the "response". It can either count a number of returned characters into a fixed buffer, match a specified character before returning, wait a fixed timeout from first reply and then return, sit and wait for data, or send then close the connection immediately, without waiting for a reply.

The response will be output in `msg.payload` as a buffer, so you may want to .toString() it.

If you leave remote host or port blank they must be set by using the `msg.host` and `msg.port` properties in every message sent to the node.



###sshexec

Runs a remote system command and returns its output.

The node can be configured to either wait until the command completes, or to send its output as the command generates it.

The command that is run can be configured in the node or provided by the received message.

**Inputs**
`payload` (*string*)
    if configured to do so, will be appended to the executed command.
`kill` (*boolean*)
    if exists will kill the currently active process.

**Outputs**
1. Standard output
`payload` (*string*)
    the standard output of the command.
`rc` (*object*)
    exec mode only, a copy of the return code object (also available on port 3)

2. Standard error
`payload` (*string*)
    the standard error of the command.
`rc` (*object*)
    exec mode only, a copy of the return code object (also available on port 3)

3. Return code
`payload` (*object*)
    an object containing the return code, and possibly message, signal properties.

**Details**

By default uses the **exec** system call which calls the command, waits for it to complete, and then returns the output. For example a successful command should have a return code of **{ code: 0 }**.

Optionally can use **spawn** instead, which returns the output from stdout and stderr as the command runs, usually one line at a time. On completion it then returns an object on the 3rd port. For example, a successful command should return **{ code: 0 }**.

Errors may return extra information on the 3rd port `msg.payload`, such as a **message string**, **signal** string.

The command that is run is defined within the node, with an option to append `msg.payload` and a further set of parameters.

Commands or parameters with spaces should be enclosed in quotes - **"This is a single parameter"**

The returned **payload** is usually a string, unless non-UTF8 characters are detected, in which case it is a buffer.

The node's status icon will be visible while the node is active. Changes to this can be read by the **Status** node.

Killing processes
Sending `msg.kill` will kill a single active process. **SIGTERM** is used by default unless the use pseudo-tty and **SIGINT** option is active.

This node will only process one command at a time. However multiple `sshexec` nodes can be used.

If a value is provided in the **Timeout** field then, if the process has not completed when the specified number of seconds has elapsed, the process will be killed automatically

Tip: if running a Python app you may need to use the **-u** parameter to stop the output being buffered.



###sshread

Reads the contents of a remote file as either a string or binary buffer.

**Inputs**
`filename` (*string*)
    if not set in the node configuration, this property sets the filename to read.

**Outputs**
`payload` (*string | buffer*)
    The contents of the file as either a string or binary buffer.
`filename` (*string*)
    If not configured in the node, this optional property sets the name of the file to be read.

**Details**

The filename must be an absolute path

Optionally, a text file can be split into lines, outputting one message per line, or a binary file split into smaller buffer chunks - the chunk size is statically set to 16k.

When split into multiple messages, each message will have a **parts** property set, forming a complete message sequence.

Encoding of input data can be specified from list of encodings if output format is string.

Errors should be caught and handled using a Catch node.



###sshwrite

Writes `msg.payload` to a remote file, either adding to the end or replacing the existing content. Alternatively, it can delete the file.

**Inputs**
`filename` (*string*)
    If not configured in the node, this optional property sets the name of the file to be updated.
`encoding` (*string*)
    If encoding is configured to be set by msg, then this optional property can set the encoding. 

**Output**
On completion of write, input message is sent to output port.

**Details**
Each message payload will be added to the end of the file, optionally appending a newline (\n) character between each one.

Each message will open write and close the file.

It can be configured to overwrite the entire file rather than append. For example, when writing binary data to a file, such as an image, this option should be used and the option to append a newline should be disabled.

Encoding of data written to a file can be specified from list of encodings.

Alternatively, this node can be configured to delete the file.


