# Gold Var Sensor Hub

A browser dashboard for an **ESP32 sensor board** and an **ESP32-CAM**. It stores every reading in a local database (IndexedDB in your browser), groups sensors automatically, and pops up live notifications.

## Run it

Double-click **`start.bat`**. This serves the app at http://localhost:8080 and opens it in your browser.
(You can also just open `index.html` directly.)

It starts in **Demo mode**, so you can see it working with no hardware.

### Online version (GitHub Pages)

The online version works fully in **Demo mode**. It is hosted on `https://`, while the ESP32 boards only use `http://`, so the browser blocks the connection to real boards unless you allow it:

1. Open the site in Chrome and click the icon at the left of the address bar, then **Site settings**.
2. Set **Insecure content** to **Allow**, then reload the page.
3. If Chrome asks to allow access to devices on your local network, click **Allow**.

Alternatively, download the repository (**Code → Download ZIP**) and run `start.bat`. The local version needs no browser changes.

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

## AI classification (Google Gemini)

The built-in rules handle common sensor names. For anything else (part numbers like `MQ135`, abbreviations, other languages), the app can ask **Google Gemini** to classify each sensor.

- **What is sent:** only the **first reading of each new sensor**: its data key, display name, value, unit and the rule-based guess. Sensors that appear in the same payload are sent together in one request. Camera images and reading history are never sent.
- **When:** once per sensor. The answer is saved in this browser and used from then on. If Gemini can't be reached, the built-in rules stay in use and the sensor is retried after a minute.
- **Priority:** your manual choice under **Settings → Detected sensors** → Gemini's answer → built-in rules. Sensors classified by Gemini show an **AI %** badge (hover it to see Gemini's reason).
- **Setup:** in **Settings → AI classification**, turn it on and paste an API key from [Google AI Studio](https://aistudio.google.com/apikey). Use **Test Gemini** to check the key. The model is configurable (default `gemini-2.5-flash`). **Re-classify all sensors** sends every sensor again, for example after you change the model.

> **API key security.** This app runs entirely in the browser, so a key typed into Settings is stored in that browser's local storage and is visible to anyone using it. That is fine for a local, single-user setup. **Don't** put a key into a shared or public deployment, such as the GitHub Pages site. Instead, run a small server-side proxy that adds the `x-goog-api-key` header and forwards requests to `https://generativelanguage.googleapis.com/v1beta`, then enter the proxy's URL as the **Endpoint** and leave the key empty. In Google Cloud, restrict the key to the Generative Language API.

## Demo mode

- **Random**: realistic drifting values with occasional spikes (an object comes close, a loud noise, muddy water, a pH swing).
- **Pre-coded script**: a fixed, repeating scenario that runs through every warning and critical alert.
- **Video**: a built-in simulated underwater camera feed, which gets murky when turbidity rises. You can also choose your own video file or URL to loop.
