"use strict";

const { Adapter, Device, Property, Action } = require('gateway-addon');
const manifest = require('./manifest.json');
const dgram = require('dgram');
const net = require('net');

// https://source.android.com/devices/input/keyboard-devices#hid-keyboard-and-keypad-page-0x07
const HID_MAP = {
    PLAY: {
        code: '176',
        type: 'consumer',
        modifier: '000', // this is actually the upper byte and not the modifiers
    },
    PAUSE: {
        code: '177',
        type: 'consumer',
        modifier: '000',
    },
    HOME: {
        code: '035',
        type: 'consumer',
        modifier: '002'
    },
    ENTER: {
        code: '040',
        type: 'keyboard',
        modifier: '000'
    },
    RIGHT: {
        code: '079',
        type: 'keyboard',
        modifier: '000'
    },
    LEFT: {
        code: '080',
        type: 'keyboard',
        modifier: '000'
    },
    DOWN: {
        code: '081',
        type: 'keyboard',
        modifier: '000'
    },
    UP: {
        code: '082',
        type: 'keyboard',
        modifier: '000'
    },
    BACK: {
        code: '036',
        type: 'consumer',
        modifier: '002'
    },
    MUTE: {
        code: '226',
        type: 'consumer',
        modifier: '000'
    },
    VOLUME_UP: {
        code: '233',
        type: 'consumer',
        modifier: '000'
    },
    VOLUME_DOWN: {
        code: '234',
        type: 'consumer',
        modifier: '000'
    },
    NEXT: {
        code: '181',
        type: 'consumer',
        modifier: '000'
    },
    PREVIOUS: {
        code: '182',
        type: 'consumer',
        modifier: '000'
    },
    STOP: {
        code: '183',
        type: 'consumer',
        modifier: '00*'
    },
    SLEEP: {
        code: '050',
        type: 'consumer',
        modifier: '000'
    },
    REWIND: {
        code: '180',
        type: 'consumer',
        modifier: '000'
    },
    FASTFORWARD: {
        code: '179',
        type: 'consumer',
        modifier: '000'
    },
    RED: {
        code: '105',
        type: 'consumer',
        modifier: '000'
    },
    GREEN: {
        code: '106',
        type: 'consumer',
        modifier: '000'
    },
    BLUE: {
        code: '107',
        type: 'consumer',
        modifier: '000'
    },
    YELLOW: {
        code: '108',
        type: 'consumer',
        modifier: '000'
    },
    CLOSED_CAPTIONS: {
        code: '097',
        type: 'consumer',
        modifier: '000'
    },
    CHANNEL_UP: {
        code: '156',
        type: 'consumer',
        modifier: '000'
    },
    CHANNEL_DOWN: {
        code: '157',
        type: 'consumer',
        modifier: '000'
    }
    //TODO guide?
};

const CONTROL_CODE = {
    consumer: {
        short: '2',
        long: '6'
    },
    keyboard: {
        short: '1',
        long: '5'
    }
};

class IRUSBProperty extends Property {
    async setValue(value) {
        if(this.name === 'power') {
            if(value) {
                return this.device.sendCommand('WAKE');
            }
            return this.device.sendKey('SLEEP');
        }
        else if(this.name === 'playing') {
            if(value) {
                return this.device.sendKey('PLAY');
            }
            return this.device.sendKey('PAUSE');
        }
    }
}

class IRUSBDevice extends Device {
    constructor(adapter, uuid, ip, port) {
        super(adapter, uuid);
        this.name = uuid;
        this.socket = new net.Socket();
        this.socket.setEncoding('ascii');
        this.addProperty(new IRUSBProperty(this, 'power', {
            title: 'Power',
            '@type': 'OnOffProperty',
            type: 'boolean'
        }));
        this.addAction('launch', {
            title: 'Launch App',
            input: {
                type: 'string'
            }
        });
        this.addAction('remoteShort', {
            title: 'Short Press',
            input: {
                type: 'string',
                enum: [
                    'PLAY',
                    'PAUSE',
                    'ENTER',
                    'HOME',
                    'BACK',
                    'UP',
                    'DOWN',
                    'LEFT',
                    'RIGHT',
                    'NEXT',
                    'PREVIOUS',
                    'REWIND',
                    'FASTFORWARD',
                    'MUTE',
                    'VOLUME_UP',
                    'VOLUME_DOWN',
                    'RED',
                    'GREEN',
                    'BLUE',
                    'YELLOW'
                ]
            }
        });
        this.addAction('remoteLong', {
            title: 'Long Press',
            input: {
                type: 'string',
                enum: [
                    'ENTER',
                    'FASTFORWARD',
                    'REWIND',
                    'UP',
                    'DOWN',
                    'LEFT',
                    'RIGHT'
                ]
            }
        });
        this.addAction('cancelKeys', {
            title: 'Cancel Presses'
        });
        this.addProperty(new IRUSBProperty(this, 'playing', {
            title: 'Playing',
            type: 'boolean'
        }));
        this.addProperty(new Property(this, 'app', {
            title: 'Application',
            type: 'string',
            readOnly: true
        }));
        this.responseQueue = [];
        this.socket.connect(port, ip, () => {
            this.connectedNotify(true);
            this.interval = setInterval(() => this.updateState(), 5000);
            this.adapter.handleDeviceAdded(this);
        });
        this.socket.on('close', () => {
            clearInterval(this.interval);
            this.interval = undefined;
            this.connectedNotify(false);
        });
        this.socket.on('data', (data) => {
            for(const waitingOn of this.responseQueue) {
                if(data.startsWith(waitingOn.code)) {
                    waitingOn.callback(data.slice(waitingOn.code.length).trim());
                    this.responseQueue.splice(this.responseQueue.indexOf(waitingOn), 1);
                    return;
                }
            }
            //TODO event for incoming IR
            console.log('Unexpected packet', data);
        });
        this.updateState();
    }

    async updateState() {
        const playing = await this.sendCommand('GETPLAY');
        const app = await this.sendCommand('GETFG');
        const isPlaying = playing === '1';
        this.findProperty('playing').setCachedValueAndNotify(isPlaying);
        this.findProperty('app').setCachedValueAndNotify(app);
        // app !== screensaver
        this.findProperty('power').setCachedValueAndNotify(isPlaying || app);
    }

    destroy() {
        clearInterval(this.interval);
        this.interval = undefined;
        this.socket.destroy();
    }

    async sendKey(keyName, long = false) {
        let pressType = long ? 'long' : 'short';
        const keyInfo = HID_MAP[keyName];
        const startCode = CONTROL_CODE[keyInfo.type][pressType];
        return this.sendCommand(`HIDCODE${startCode}${keyInfo.modifier}${keyInfo.code}`);
    }

    sendCommand(command) {
        return new Promise((resolve) => {
            const fullCommand = `Q${command}\r`;
            this.responseQueue.push({
                code: fullCommand,
                callback(response) {
                    resolve(response.split('\r').filter((part) => part.length && part !== 'OK').join('\r'));
                }
            });
            this.socket.write(fullCommand);
        });
    }

    reconnect(ip, port) {
        if(this.socket.readyState !== 'open') {
            if(!this.interval) {
                this.interval = setInterval(() => this.updateState(), 5000);
            }
            this.socket.connect(port, ip, () => {
                this.connectedNotify(true);
            });
        }
    }

    /**
     *
     * @param {Action} action
     */
    async performAction(action) {
        switch(action.getName()) {
            case 'launch':
                return this.sendCommand(`LAUNCH ${action.getInput()}`);
            case 'remoteShort':
                return this.sendKey(action.getInput(), false);
            case 'remoteLong':
                return this.sendKey(action.getInput(), true);
            case 'cancelKeys':
                return this.sendCommand('HIDCODE0000000');
        }
    }
}

class IRUSBAdapter extends Adapter {
    constructor(addonManager) {
        super(addonManager, manifest.id, manifest.id);
        addonManager.addAdapter(this);

        this.startDiscovering();
    }

    async startDiscovering() {
        //TODO close socket on unload!
        this.socket = dgram.createSocket({
            type: 'udp4'
        });
        await new Promise((resolve) => this.socket.bind(1904, resolve));
        this.socket.setBroadcast(true);
        this.socket.addMembership('239.255.255.250');
        this.socket.on('message', (message, info) => {
            const string = message.toString('ascii');
            if(string.startsWith('NOTIFY \n')) {
                const [ header, uuid, ip, port ] = string.split('\n');
                this.onDevice(uuid.trim(), ip.trim(), port.trim());
            }
        });
    }

    onDevice(uuid, ip, port) {
        if(!this.devices[uuid]) {
            new IRUSBDevice(this, uuid, ip, port);
        }
        else {
            this.devices[uuid].reconnect(ip, port);
        }
    }

    handleDeviceRemoved(device) {
        device.destroy();
        super.handleDeviceRemoved(device);
    }

    async unload() {
        await new Promise((resolve) => {
            this.socket.close(resolve);
        });
        return super.unload();
    }
}

module.exports = (addonManager) => {
    new IRUSBAdapter(addonManager);
};
