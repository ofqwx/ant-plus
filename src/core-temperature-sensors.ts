/*
 * ANT+ profile: https://www.thisisant.com/developer/ant-plus/device-profiles/#521_tab
 * Spec sheet: https://www.thisisant.com/resources/bicycle-power/
 */

import { Messages, SendCallback, AntPlusSensor, AntPlusScanner } from "./ant";

enum BATTERY_STATUS {
  New,
  Good,
  Ok,
  Low,
  Critical,
  Invalid,
}

class CoreTemepratureSensorState {
  constructor(deviceID: number) {
    this.DeviceID = deviceID;
  }

  static VALID_CORE_TEMP = 24.0;

  eventCount?: number;
  CoreTemp?: number;
  SkinTemp?: number;
  dataQuality?: number;
  coreReserved?: number;
  batteryState?: string;
  usingHeartRate?: boolean;
  hwVersion?: number;
  manufactureID?: number;
  hwModelNumber?: number;
  firmwareVersion?: number;
  deviceSerialNumber?: number;

  DeviceID: number;

  UTCTimeRequired?: boolean;

  MeasurementInterval?: 0.25 | 0.5 | 1 | 2;

  public isValidCoreTemp(temperature) {
    // check that current temp is valid
    //---------------------------------
    return temperature > CoreTemepratureSensorState.VALID_CORE_TEMP; // invalid core temp ie. zero
  }
}

class CoreTemperatureScanState extends CoreTemepratureSensorState {
  Rssi: number;
  Threshold: number;
}

export class CoreTemperatureSensor extends AntPlusSensor {
  static deviceType = 0x7f;
  static period = 16384; // 2Hz transmition rate
  static page_core_info = 0x00;
  static page_core_temp = 0x01;
  static page_battery = 0x52;
  static sensor_timeout = 255; // in seconds but open sensor as 12 * 2.5 sec = 30

  public attach(channel, deviceID): void {
    super.attach(
      channel,
      "receive",
      deviceID,
      CoreTemperatureSensor.deviceType,
      0,
      CoreTemperatureSensor.sensor_timeout,
      CoreTemperatureSensor.period
    );
    this.state = new CoreTemepratureSensorState(deviceID);
  }

  private state: CoreTemepratureSensorState;

  protected updateState(deviceId, data) {
    this.state.DeviceID = deviceId;
    updateState(this, this.state, data);
  }

  private _sendTimeCmd(cmd: number, cbk?: SendCallback) {
    const now = new Date();
    const utc = Math.round(
      (now.getTime() - Date.UTC(1989, 11, 31, 0, 0, 0, 0)) / 1000
    );
    const offset = -Math.round(now.getTimezoneOffset() / 15);
    const payload = [
      0x10,
      cmd & 0xff,
      0xff,
      offset & 0xff,
      (utc >> 0) & 0xff,
      (utc >> 8) & 0xff,
      (utc >> 16) & 0xff,
      (utc >> 24) & 0xff,
    ];
    const msg = Messages.acknowledgedData(this.channel, payload);
    this.send(msg, cbk);
  }

  public setUTCTime(cbk?: SendCallback) {
    this._sendTimeCmd(0x00, cbk);
  }

  public startSession(cbk?: SendCallback) {
    this._sendTimeCmd(0x01, cbk);
  }

  public stopSession(cbk?: SendCallback) {
    this._sendTimeCmd(0x02, cbk);
  }

  public setLap(cbk?: SendCallback) {
    this._sendTimeCmd(0x03, cbk);
  }
}

export class CoreTemperatureScanner extends AntPlusScanner {
  protected deviceType() {
    return CoreTemperatureSensor.deviceType;
  }

  private states: { [id: number]: CoreTemperatureScanState } = {};

  protected createStateIfNew(deviceId) {
    if (!this.states[deviceId]) {
      this.states[deviceId] = new CoreTemperatureScanState(deviceId);
    }
  }

  protected updateRssiAndThreshold(deviceId, rssi, threshold) {
    this.states[deviceId].Rssi = rssi;
    this.states[deviceId].Threshold = threshold;
  }

  protected updateState(deviceId, data) {
    updateState(this, this.states[deviceId], data);
  }
}

function updateState(
  sensor: CoreTemperatureSensor | CoreTemperatureScanner,
  state: CoreTemepratureSensorState | CoreTemperatureScanState,
  data: Buffer
) {
  const oldEventCount = state.eventCount || 0;
  const CORE_OEM_ID = 303; // CORE developer id = greenTEG
  const ACK_NONE = 0x00;
  const ACK_UTC_TIME = 0x01;
  const ACK_HEART_RATE = 0x02;

  let ackRequest = ACK_NONE;

  const page = data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA);
  switch (page) {
    case 0x01: {
      let eventCount = data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA + 2);

      if (eventCount !== oldEventCount) {
        state.eventCount = eventCount;
        if (oldEventCount > eventCount) {
          //Hit rollover value
          eventCount += 255;
        }
      }

      // -----------------
      // CORE Temperature
      // -----------------
      const newTemperature =
        (data[Messages.BUFFER_INDEX_MSG_DATA + 7] << 8) |
        data[Messages.BUFFER_INDEX_MSG_DATA + 6];
      state.CoreTemp = newTemperature / 100;

      const newSkinTemperature =
        ((data[Messages.BUFFER_INDEX_MSG_DATA + 4] & 0xf0) << 4) |
        data[Messages.BUFFER_INDEX_MSG_DATA + 3];
      if (newSkinTemperature == -32768) {
        // 0X8000
        state.SkinTemp = 0.0; // invalid Temp
      } else {
        state.SkinTemp = newSkinTemperature / 20.0; // data stored as SkinTemp * 2 * 10 for 0.05 accuracy
      }

      const newCoreReserved =
        (data[Messages.BUFFER_INDEX_MSG_DATA + 5] << 4) |
        (data[Messages.BUFFER_INDEX_MSG_DATA + 4] & 0x0f);
      if (newCoreReserved == -32768) {
        // 0X8000
        state.coreReserved = 0.0; // invalid Temp
      } else {
        state.coreReserved = newCoreReserved / 100; // not defined yet
      }

      break;
    }
    case 0x50: {
      state.hwVersion = data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA + 3);
      state.manufactureID =
        ((data[Messages.BUFFER_INDEX_MSG_DATA + 5] & 0x00ff) << 8) |
        (data[Messages.BUFFER_INDEX_MSG_DATA + 4] & 0x00ff);
      state.hwModelNumber =
        ((data[Messages.BUFFER_INDEX_MSG_DATA + 7] & 0x00ff) << 8) |
        (data[Messages.BUFFER_INDEX_MSG_DATA + 6] & 0x00ff);
      break;
    }
    case 0x51: {
      if (data[Messages.BUFFER_INDEX_MSG_DATA + 2] == 255) {
        state.firmwareVersion = data[Messages.BUFFER_INDEX_MSG_DATA + 3];
      } else {
        state.firmwareVersion =
          data[Messages.BUFFER_INDEX_MSG_DATA + 3] * 100 +
          data[Messages.BUFFER_INDEX_MSG_DATA + 2];
      }

      state.deviceSerialNumber =
        (data[Messages.BUFFER_INDEX_MSG_DATA + 7] << 24) +
        (data[Messages.BUFFER_INDEX_MSG_DATA + 6] << 16) +
        (data[Messages.BUFFER_INDEX_MSG_DATA + 5] << 8) +
        data[Messages.BUFFER_INDEX_MSG_DATA + 4];

      break;
    }
    case 0x52: {
      // Battery Status message
      //-----------------------
      // 0 Reserved for future use
      // 0   also Battery not set
      // 1 Battery Status = New
      // 2 Battery Status = Good
      // 3 Battery Status = Ok
      // 4 Battery Status = Low
      // 5 Battery Status = Critical
      // 6 Reserved for future use
      // 7 Invalid
      const batteryNumberValue =
        (data[Messages.BUFFER_INDEX_MSG_DATA + 7] & 0x70) >> 4;
      state.batteryState = BATTERY_STATUS[batteryNumberValue];

      if (batteryNumberValue < 1 || batteryNumberValue > 5) {
        state.batteryState = BATTERY_STATUS[2]; // invalid or unsported battery voltage - so ignore by saying status is Ok
      }
    }
    default: {
      return state;
    }
  }

  if (page !== 0x01 || state.eventCount !== oldEventCount) {
    sensor.emit("coreTempData", state);
  }
}
