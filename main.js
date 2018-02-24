/**
 *
 * Onvif adapter
 *
 */

/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

// you have to require the utils module and call adapter function
var utils =    require(__dirname + '/lib/utils'); // Get common adapter utils

// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.template.0
var adapter = new utils.Adapter('onvif');

var Cam = require('onvif').Cam;
var flow = require('nimble');
require('onvif-snapshot');

var isDiscovery = false;

var cameras = {};


// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
    if (isDiscovery) {
        adapter && adapter.setState && adapter.setState('discoveryRunning', false, true);
        isDiscovery = false;
    }
    try {
        adapter.log.debug('cleaned everything up...');
        callback();
    } catch (e) {
        callback();
    }
});


// is called if a subscribed object changes
adapter.on('objectChange', function (id, obj) {
    // Warning, obj can be null if it was deleted
    adapter.log.debug('objectChange ' + id + ' ' + JSON.stringify(obj));
});


// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
    // Warning, state can be null if it was deleted
    adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));

    // you can use the ack flag to detect if it is status (true) or command (false)
    if (state && !state.ack) {
        adapter.log.debug('ack is not set!');
    }
});


// Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
adapter.on('message', function (obj) {
    if (!obj || !obj.command) return;
    switch (obj.command) {
        case 'discovery':
            adapter.log.debug('Received "discovery" event');
            discovery(obj.message, function (error, newInstances, devices) {
                isDiscovery = false;
                adapter.log.debug('Discovery finished');
                adapter.setState('discoveryRunning', false, true);
                adapter.sendTo(obj.from, obj.command, {
                    error:        error,
                    devices:      devices,
                    newInstances: newInstances
                }, obj.callback);
            });
            break;
        case 'getDevices':
            adapter.log.debug('Received "getDevices" event');
            getDevices(obj.from, obj.command, obj.message, obj.callback);
            break;
        case 'deleteDevice':
            adapter.log.debug('Received "deleteDevice" event');
            deleteDevice(obj.from, obj.command, obj.message, obj.callback);
            break;
        case 'getSnapshot':
            adapter.log.debug('Received "getSnapshot" event');
            getSnapshot(obj.from, obj.command, obj.message, obj.callback);
            break;
        default:
            adapter.log.debug('Unknown message: ' + JSON.stringify(obj));
            break;
    }
});


// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', function () {
    main();
});


function main() {
    isDiscovery = false;
    adapter.setState('discoveryRunning', false, true);
    // in this template all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('*');
    // connect to cameras
    startCameras();
}


function getSnapshot(from, command, message, callback){
    var camId = message.id,
        cam = cameras[camId];
    adapter.log.debug('getSnapshot: ' + JSON.stringify(message));
    if (cam) {
        // get snapshot
        cam.getSnapshot((err, data) => {
            if(err) throw err;
            //adapter.log.debug(JSON.stringify(data));
            adapter.sendTo(from, command, data, callback);
        });
    }
}

function startCameras(){
    cameras = {};
    adapter.log.debug('startCameras');
    adapter.getDevices((err, result) => {
        adapter.log.debug('startCameras: ' + JSON.stringify(result));
        for (var item in result) {
            let dev = result[item],
                devData = dev.common.data,
                cam;
            updateState(dev._id, 'connected', false, {type: 'boolean'});
            cam = new Cam({
                hostname: devData.ip,
                port: devData.port,
                username: devData.user,
                password: devData.pass,
                timeout : 5000
            }, function(err) {
                if (!err) {
                    adapter.log.debug('capabilities: ' + JSON.stringify(cam.capabilities));
                    updateState(dev._id, 'connected', true, {type: 'boolean'});
                    cameras[dev._id] = cam;
                } else {
                    adapter.log.info('startCameras err=' + err +' dev='+ JSON.stringify(devData));
                }
            });
        }
    });
}


function updateState(dev_id, name, value, common) {
    var id = dev_id + '.' + name;
    adapter.getObject(dev_id, function(err, obj) {
        if (obj) {
            let new_common = {
                name: name,
                role: (common != undefined && common.role == undefined) ? 'value' : common.role,
                read: true,
                write: (common != undefined && common.write == undefined) ? false : true
            };
            if (common != undefined) {
                if (common.type != undefined) {
                    new_common.type = common.type;
                }
                if (common.unit != undefined) {
                    new_common.unit = common.unit;
                }
                if (common.states != undefined) {
                    new_common.states = common.states;
                }
            }
            adapter.extendObject(id, {type: 'state', common: new_common});
            adapter.setState(id, value, true);
        } else {
            adapter.log.info('no device '+dev_id);
        }
    });
}


function deleteDevice(from, command, msg, callback) {
    var id = msg.id,
        dev_id = id.replace(adapter.namespace+'.', '');
    adapter.log.info('delete device '+dev_id);
    adapter.deleteDevice(dev_id, function(){
        adapter.sendTo(from, command, {}, callback);
    });
}


function getDevices(from, command, message, callback){
    var rooms;
    adapter.getEnums('enum.rooms', function (err, list) {
        if (!err){
            rooms = list['enum.rooms'];
        }
        adapter.getDevices((err, result) => {
            if (result) {
                var devices = [], cnt = 0, len = result.length;
                for (var item in result) {
                    if (result[item]._id) {
                        var id = result[item]._id.substr(adapter.namespace.length + 1);
                        let devInfo = result[item];
                        devInfo.rooms = [];
                        for (var room in rooms) {
                            if (!rooms[room] || !rooms[room].common || !rooms[room].common.members)
                                continue;
                            if (rooms[room].common.members.indexOf(devInfo._id) !== -1) {
                                devInfo.rooms.push(rooms[room].common.name);
                            }
                        }
                        cnt++;
                        devices.push(devInfo);
                        if (cnt==len) {
                            adapter.log.debug('getDevices result: ' + JSON.stringify(devices));
                            adapter.sendTo(from, command, devices, callback);
                        }
                        // adapter.getState(result[item]._id+'.paired', function(err, state){
                        //     cnt++;
                        //     if (state) {
                        //         devInfo.paired = state.val;
                        //     }
                        //     devices.push(devInfo);
                        //     if (cnt==len) {
                        //         adapter.log.info('getDevices result: ' + JSON.stringify(devices));
                        //         adapter.sendTo(from, command, devices, callback);
                        //     }
                        // });
                    }
                }
                if (len == 0) {
                    adapter.log.debug('getDevices result: ' + JSON.stringify(devices));
                    adapter.sendTo(from, command, devices, callback);
                }
            }
        });
    });
}


function discovery(options, callback) {
    if (isDiscovery) {
        return callback && callback('Yet running');
    }
    isDiscovery = true;
    adapter.setState('discoveryRunning', true, true);

    var start_range = options.start_range,  //'192.168.1.1'
        end_range = options.end_range || options.start_range,  //'192.168.1.254'
        port_list = options.ports || '80, 7575, 8000, 8080, 8081',
        port_list = port_list.split(',').map(item => item.trim()),
        user = options.user || 'admin',  // 'admin'
        pass = options.pass || 'admin';  // 'admin'

    var ip_list = generate_range(start_range, end_range);
    if (ip_list.length === 1 && ip_list[0] === '0.0.0.0') {
        ip_list = [options.start_range];
    }

    var devices = [], counter = 0, scanLen = ip_list.length * port_list.length;

    // try each IP address and each Port
    ip_list.forEach(function(ip_entry) {
        port_list.forEach(function(port_entry) {

            adapter.log.debug(ip_entry + ' ' + port_entry);

            new Cam({
                hostname: ip_entry,
                username: user,
                password: pass,
                port: port_entry,
                timeout : 5000
            }, function CamFunc(err) {
                counter++;
                if (err) {
                    if (counter == scanLen) processScannedDevices(devices, callback);
                    return;
                }

                var cam_obj = this;

                var got_date;
                var got_info;
                var got_live_stream_tcp;
                var got_live_stream_udp;
                var got_live_stream_multicast;
                var got_recordings;
                var got_replay_stream;

                // Use Nimble to execute each ONVIF function in turn
                // This is used so we can wait on all ONVIF replies before
                // writing to the console
                flow.series([
                    function(callback) {
                        cam_obj.getSystemDateAndTime(function(err, date, xml) {
                            if (!err) got_date = date;
                            callback();
                        });
                    },
                    function(callback) {
                        cam_obj.getDeviceInformation(function(err, info, xml) {
                            if (!err) got_info = info;
                            callback();
                        });
                    },
                    function(callback) {
                        try {
                            cam_obj.getStreamUri({
                                protocol: 'RTSP',
                                stream: 'RTP-Unicast'
                            }, function(err, stream, xml) {
                                if (!err) got_live_stream_tcp = stream;
                                callback();
                            });
                        } catch(err) {callback();}
                    },
                    function(callback) {
                        try {
                            cam_obj.getStreamUri({
                                protocol: 'UDP',
                                stream: 'RTP-Unicast'
                            }, function(err, stream, xml) {
                                if (!err) got_live_stream_udp = stream;
                                callback();
                            });
                        } catch(err) {callback();}
                    },
                    function(callback) {
                        try {
                            cam_obj.getStreamUri({
                                protocol: 'UDP',
                                stream: 'RTP-Multicast'
                            }, function(err, stream, xml) {
                                if (!err) got_live_stream_multicast = stream;
                                callback();
                            });
                        } catch(err) {callback();}
                    },
                    function(callback) {
                        cam_obj.getRecordings(function(err, recordings, xml) {
                            if (!err) got_recordings = recordings;
                            callback();
                        });
                    },
                    function(callback) {
                        // Get Recording URI for the first recording on the NVR
                        if (got_recordings) {
                            //adapter.log.debug('got_recordings='+JSON.stringify(got_recordings));
                            if (Array.isArray(got_recordings)) {
                                got_recordings = got_recordings[0];
                            }
                            cam_obj.getReplayUri({
                                protocol: 'RTSP',
                                recordingToken: got_recordings.recordingToken
                            }, function(err, stream, xml) {
                                if (!err) got_replay_stream = stream;
                                callback();
                            });
                        } else {
                            callback();
                        }
                    },
                    function(localcallback) {
                        adapter.log.debug('------------------------------');
                        adapter.log.debug('Host: ' + ip_entry + ' Port: ' + port_entry);
                        adapter.log.debug('Date: = ' + got_date);
                        adapter.log.debug('Info: = ' + JSON.stringify(got_info));
                        if (got_live_stream_tcp) {
                            adapter.log.debug('First Live TCP Stream: =       ' + got_live_stream_tcp.uri);
                        }
                        if (got_live_stream_udp) {
                            adapter.log.debug('First Live UDP Stream: =       ' + got_live_stream_udp.uri);
                        }
                        if (got_live_stream_multicast) {
                            adapter.log.debug('First Live Multicast Stream: = ' + got_live_stream_multicast.uri);
                        }
                        if (got_replay_stream) {
                            adapter.log.debug('First Replay Stream: = ' + got_replay_stream.uri);
                        }
                        adapter.log.debug('capabilities: ' + JSON.stringify(cam_obj.capabilities));
                        adapter.log.debug('------------------------------');
                        devices.push({
                            id: getId(ip_entry+':'+port_entry),
                            name: ip_entry+':'+port_entry,
                            ip: ip_entry,
                            port: port_entry,
                            user: user,
                            pass: pass,
                            ip: ip_entry,
                            port: port_entry,
                            cam_date: got_date,
                            info: got_info,
                            live_stream_tcp: got_live_stream_tcp,
                            live_stream_udp: got_live_stream_udp,
                            live_stream_multicast: got_live_stream_multicast,
                            replay_stream: got_replay_stream
                        });
                        localcallback();
                        if (counter == scanLen) processScannedDevices(devices, callback);
                    }
                ]); // end flow

            });
        }); // foreach
    }); // foreach
}


function processScannedDevices(devices, callback) {
    // check if device is new
    var newInstances = [], currDevs = [];
    adapter.getDevices((err, result) => {
        if(result) {
            for (var item in result) {
                if (result[item]._id) {
                    currDevs.push(result[item]._id);
                }
            }
        }
        for (var devInd in devices) {
            var dev = devices[devInd];
            if (currDevs.indexOf(dev.id) == -1) {
                newInstances.push(dev);
                // create new camera
                updateDev(dev.id, dev.name, dev);
            }
        }
        startCameras();
        if (callback) callback(newInstances);
    });
}


function updateDev(dev_id, dev_name, devData) {
    // create dev
    adapter.setObjectNotExists(dev_id, {
        type: 'device',
        common: {name: dev_name, data: devData}
    }, {}, function (obj) {
        adapter.getObject(dev_id, function(err, obj) {
            if (!err && obj) {
                // if update
                adapter.extendObject(dev_id, {
                    type: 'device',
                    common: {data: devData}
                });
                startCameras();
            }
        });
    });
}


function getId(addr) {
    return addr.replace(/\./g, '_').replace(':', '_');
}


function generate_range(start_ip, end_ip) {
    var start_long = toLong(start_ip);
    var end_long = toLong(end_ip);
    if (start_long > end_long) {
        var tmp=start_long;
        start_long=end_long
        end_long=tmp;
    }
    var range_array = [];
    var i;
    for (i=start_long; i<=end_long;i++) {
        range_array.push(fromLong(i));
    }
    return range_array;
}


//toLong taken from NPM package 'ip'
function toLong(ip) {
    var ipl = 0;
    ip.split('.').forEach(function(octet) {
        ipl <<= 8;
        ipl += parseInt(octet);
    });
    return(ipl >>> 0);
};


//fromLong taken from NPM package 'ip'
function fromLong(ipl) {
    return ((ipl >>> 24) + '.' +
        (ipl >> 16 & 255) + '.' +
        (ipl >> 8 & 255) + '.' +
        (ipl & 255) );
};