# Gold Var Sensor Hub

A dashboard app for the GOLD-VAR system: an **ESP32 gateway** (or sensor board) and an **ESP32-CAM**. It stores every reading in a local database on the device, groups sensors automatically, and pops up live notifications.

## Install it

**Android:** download **`GoldVarSensorHub.apk`** from this repository's **Releases** page, open it on the phone, and allow **Install unknown apps** when asked. The phone must be on the same WiFi or hotspot as the ESP32.

**Windows:** an `.exe` is planned. Until then, double-click **`start.bat`**, which serves the app at http://localhost:8080 and opens it in your browser.

The app starts in **Demo mode**, so you can see it working with no hardware.

### Building the Android app

GitHub builds it automatically (`.github/workflows/build-apk.yml`). Every push to `main` builds the APK; download it from the workflow run's **Artifacts**. To publish a Release, push a version tag:

```
git tag v0.1.0
git push origin v0.1.0
```

The app is the same `index.html`, `css/` and `js/`, wrapped with [Capacitor](https://capacitorjs.com) (`capacitor.config.json`). It allows plain `http://` so it can reach the ESP32 on the local network.

## Screens

| Screen | What it does |
|---|---|
| **Home** | Two thumbnails, **Live Feed** and **Database**, plus the live notification feed |
| **Live Feed** | ESP32-CAM MJPEG stream (or the demo loop) with a sensor overlay, snapshots and fullscreen |
| **Database** | Sensors grouped automatically (Water Quality, Sound & Vibration, …), each with a sparkline and min/avg/max. Below that is a filterable record table and CSV export |
| **Settings** (gear icon) | Board IPs, demo mode, demo video, notification options, detected sensors (with classification override) and alert thresholds |

## Connecting the boards

1. **Sensor board:** flash `firmware/esp32_sensors/esp32_sensors.ino`, after setting your Wi-Fi name and password. The Serial Monitor prints the board's IP.
2. **Camera:** flash the stock Arduino example *ESP32 → Camera → CameraWebServer* (select your camera model, for example `CAMERA_MODEL_AI_THINKER`). It streams at `http://<ip>:81/stream` and serves snapshots at `http://<ip>/capture`.
3. In **Settings**, turn **Demo mode off**, then enter both IPs. Use **Test connection** and **Test camera** to confirm each one.

Your computer must be on the same Wi-Fi network as the boards. If Chrome asks whether to allow access to devices on your local network, click **Allow**.

## GOLD-VAR system (Arduino Mega + ESP32 gateway)

In the full GOLD-VAR system, the Arduino Mega stays the master controller and an **ESP32 DevKit** connects it to Wi-Fi:

```
Nano nodes ──nRF24──► Mega 2560 ──Serial3──► ESP32 gateway ──Wi-Fi / phone hotspot──► Sensor Hub
```

1. Open `firmware/esp32_wifi_gateway/esp32_wifi_gateway.ino`. Type your Wi-Fi or phone-hotspot name and password at the top. In the Arduino IDE, select **Tools → Board → ESP32 Dev Module**, then click Upload. No extra libraries are needed.
2. Wire the Mega to the ESP32 (**common GND is required**):

   | Mega 2560 | ESP32 DevKit | Note |
   |---|---|---|
   | TX3 (D14) | GPIO16 | through a **1 kΩ / 2 kΩ divider**: Mega TX3 to 1 kΩ to GPIO16, and GPIO16 to 2 kΩ to GND. This turns 5 V into 3.3 V. |
   | RX3 (D15) | GPIO17 | direct |
   | GND | GND | |

   Power the ESP32 from USB or from 5 V into VIN.
3. Connect your phone or laptop to the **same Wi-Fi or hotspot**. Read the IP address on the Mega's LCD (page 4, `IP: …`) or in the ESP32's Serial Monitor. Type it into **Settings → ESP32 sensor board** and turn **Demo mode** off.

Notes:
- **Use a 2.4 GHz network.** The ESP32 can't join 5 GHz networks. On an iPhone, turn on **Maximize Compatibility** in the hotspot settings.
- **Backup hotspot:** if your Wi-Fi isn't found within 30 seconds, the ESP32 starts its own hotspot **`GOLD-VAR`** (password `goldvar123`). Join it and use the address `192.168.4.1`. The LCD then shows `AP: 192.168.4.1`. Restart the ESP32 to try your own Wi-Fi again.
- **Address on most laptops:** `goldvar.local` usually works instead of the IP address.
- **Alarm colours match the Mega:** the dashboard shows the Mega's own NORMAL / WARNING / DANGER decision for each node.

### Changing the Mega or node code

The ESP32 is a **pass-through**. It accepts any readable text line from the Mega and shows the lines from the last 5 seconds at `/data`, newest first. You can change the Mega and node code freely without re-flashing the ESP32.

The easiest format for the Mega to print, one line per second, is:

```
node1_pir=ON!danger node2_sound=305.4ADC!ok node4_distance=45cm!warning ph=7.1 turbidity=12NTU
```

Each reading is `name=value`, written with no spaces. The value is a number or a word such as `ON`/`OFF`. Two parts are optional: a unit directly after the number (`cm`, `ADC`, `NTU`, …), and an alarm marker (`!ok`, `!warning` or `!danger`). A reading without a marker is judged by the alert thresholds in Settings. Names are grouped automatically by what they contain: `pir` or `motion`, `sound`, `vib`, `dist`, `ph`, `turb`, `tds`, `temp`, and so on.

### AI helper (optional)

If the Mega prints something the built-in reader can't understand, the **AI helper** can work it out. Examples are free text like `NODE 3 SHAKING level 87`, or a name it can't classify like `h2s_lvl=12`. It uses **Google Gemini's free tier** (model `gemini-3.5-flash-lite`). One key is built into the site, so it works for everyone with no setup.

**Setup (once):**
1. Go to [aistudio.google.com](https://aistudio.google.com) and choose **Get API key**. Keep billing **off** for that project.
2. Add it to GitHub as a **repository secret** named `GEMINI_API_KEY`: **Settings → Secrets and variables → Actions → New repository secret**. The Android build inserts it into the app; `js/ai-config.js` stays empty in the code. For a quick local test you can paste a key into that file, but don't commit it.
3. Recommended: in [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials), restrict the key to the *Generative Language API*.
4. Build the app (push to `main`, or push a `v*` tag for a Release).

How it works:
- **Only unreadable items are sent to Google:** unreadable lines, and names that would otherwise show as *Unclassified*. Everything the reader understands never leaves the device.
- **Each answer is saved on the device as a rule.** Lines are matched with their numbers ignored, so `NODE 3 SHAKING level 87` and `NODE 3 SHAKING level 12` share one rule. After learning, everything works instantly and offline.
- **It needs internet only when something new appears.** It makes at most 20 requests per hour per device, and pauses 15 minutes if Google's free limit is reached.
- To reset it, use **Forget learned rules**. To correct a single sensor, use **Settings → Detected sensors**. Your manual choice always wins over the AI's.

About the key being public:
- **Anyone can read the key** from GitHub Pages or the apps. With a free-tier key and billing off, **it can't cost money**. The worst case is someone using up the free quota, or Google disabling the key, so the AI helper stops. Fix it by making a new key and updating `js/ai-config.js`.
- **On Gemini's free tier, Google may use what is sent to improve its products.** Here that is only the unreadable sensor text.
- **The rest of the dashboard never depends on the AI helper.** With no key, or a disabled one, everything else works normally.

## App notes (Android .apk and Windows .exe)

- **One code base:** the apps bundle the same `index.html`, `css/` and `js/`, with relative paths and no server needed. Android uses Capacitor; Windows (planned) can use Electron.
- **AI key:** the apps use the built-in key from `js/ai-config.js` (see above).
- **Android settings already in place:**
  - The app runs on an `http://` scheme and allows plain HTTP (`usesCleartextTraffic`), so it can reach the ESP32 on the local network.
  - `goldvar.local` usually doesn't resolve on phones, so use the IP address shown on the Mega's LCD (page 4).
- **The Android APK is a debug build.** It installs directly from the file and isn't meant for the Play Store.

## Smart classification

The app doesn't need a fixed format. It accepts any of these:

```json
{ "ultrasonic_cm": 42.1, "ph": 7.2, "turbidity_ntu": 3.4 }
{ "sensors": { "DHT22": { "temperature": 24.1, "humidity": 55 } }, "accel": [0.1, 0.2, 0.98] }
[ { "name": "tank", "value": 72, "unit": "%" }, { "name": "flame", "value": false } ]
Temp: 23.4 C, pH: 7.1, Sound: 52 dB
```

Each value is classified from its key name, its unit (either the key suffix like `_cm`, or a `unit` field) and its value type. It is then placed in a group. Recognised types include ultrasonic/distance, vibration, sound, turbidity, pH, TDS, dissolved oxygen, water level, flow, temperature, humidity, pressure, gas/air quality, light, rain, flame, soil moisture, PIR/motion, accelerometer, gyroscope, voltage, current, power, battery, heart rate/SpO₂, GPS, touch, hall/reed, relays and device stats.

To add a sensor, add another `"key": value` to the firmware's JSON. It will appear in the dashboard automatically. If a guess is wrong, override it under **Settings → Detected sensors**.

## Demo mode

- **Random**: realistic drifting values with occasional spikes (an object comes close, a loud noise, muddy water, a pH swing).
- **Pre-coded script**: a fixed, repeating scenario that runs through every warning and critical alert.
- **Video**: a built-in simulated underwater camera feed, which gets murky when turbidity rises. You can also choose your own video file or URL to loop.
