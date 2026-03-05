import React, { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import * as satellite from 'satellite.js'

// Keys - Replace these!
const GOOGLE_API_KEY = 'YOUR_GOOGLE_MAPS_API_KEY_HERE' // For photoreal tiles
const OPENWEATHER_API_KEY = 'YOUR_OPENWEATHER_API_KEY_HERE' // For weather radar

Cesium.Ion.defaultAccessToken = '' // Optional Cesium Ion for extras

function App() {
  const viewerRef = useRef(null)
  const [timestamp, setTimestamp] = useState(new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '').replace(/-/g, '-').replace(/ /, ' '))
  const [scanIntensity, setScanIntensity] = useState(0.4)
  const [distortion, setDistortion] = useState(0.02)
  const [noise, setNoise] = useState(0.3)
  const [preset, setPreset] = useState('CRT')

  useEffect(() => {
    const viewer = new Cesium.Viewer('cesiumContainer', {
      terrain: Cesium.Terrain.fromWorldTerrain(),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      selectionIndicator: false,
      timeline: false,
      animation: false,
      skyBox: false,
      fullscreenButton: false,
      // Mobile touch
      useDefaultRenderLoop: true,
    })
    viewerRef.current = viewer

    // Photoreal 3D Tiles
    async function addPhotoreal() {
      try {
        const tileset = await Cesium.createGooglePhotorealistic3DTileset({ apiKey: GOOGLE_API_KEY })
        viewer.scene.primitives.add(tileset)
      } catch (e) {
        console.warn('Photoreal fallback to OSM')
        viewer.scene.primitives.add(Cesium.createOsmBuildings())
        viewer.imageryLayers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider())
      }
    }
    addPhotoreal()

    // CRT Post-Process Shader (scanlines, distortion, aberration, noise)
    const crtFragmentShader = `
      uniform sampler2D colorTexture;
      varying vec2 v_textureCoordinates;
      uniform float scanIntensity;
      uniform float distortion;
      uniform float noise;
      uniform float aberration; // For chromatic

      float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
      }

      void main() {
        vec2 uv = v_textureCoordinates;
        // Barrel distortion
        vec2 center = uv - 0.5;
        float r2 = dot(center, center);
        uv = 0.5 + center * (1.0 + distortion * r2);

        // Chromatic aberration
        vec2 offset = aberration * (uv - 0.5);
        float r = texture2D(colorTexture, uv + offset * vec2(0.005, 0.0)).r;
        float g = texture2D(colorTexture, uv).g;
        float b = texture2D(colorTexture, uv + offset * vec2(-0.005, 0.0)).b;

        vec4 color = vec4(r, g, b, 1.0);

        // Scanlines
        float scan = sin(uv.y * 800.0) * 0.5 + 0.5;
        color.rgb *= mix(1.0, vec3(0.8, 1.2, 0.8), (1.0 - scan) * scanIntensity);

        // Noise
        color.rgb += (random(uv * 100.0 + fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453)) - 0.5) * noise * 0.1;

        gl_FragColor = color;
      }
    `
    const crtStage = viewer.scene.postProcessStages.add(Cesium.PostProcessStage.fromShader(
      'crtShader',
      crtFragmentShader,
      {
        scanIntensity,
        distortion,
        noise,
        aberration: 1.0 // Fixed for now
      }
    ))
    crtStage.enabled = true

    // Update shader uniforms live
    const updateShader = () => {
      crtStage.uniforms.scanIntensity = scanIntensity
      crtStage.uniforms.distortion = distortion
      crtStage.uniforms.noise = noise
    }
    updateShader()

    // Live Aircraft (OpenSky)
    let aircraftEntities = []
    async function loadAircraft() {
      try {
        const res = await fetch('https://opensky-network.org/api/states/all')
        const data = await res.json()
        aircraftEntities.forEach(e => viewer.entities.remove(e))
        aircraftEntities = []
        data.states?.forEach(([icao24, callsign, origin, timePosition, lastContact, lon, lat, baroAltitude, onGround, velocity, trueTrack, verticalRate, sensors, geoAltitude, mlat, ttrack, calcTrack, altitude, ...rest]) => {
          if (lon === null || lat === null) return
          const color = velocity > 200 ? Cesium.Color.RED.withAlpha(0.8) : Cesium.Color.CYAN.withAlpha(0.8) // Military guess
          const entity = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, (baroAltitude || 0) * 0.3048), // ft to m
            point: { pixelSize: 8, color, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
            label: { text: callsign || 'UNK', font: '14px VT323', fillColor: color, outlineColor: Cesium.Color.BLACK, style: Cesium.LabelStyle.FILL_AND_OUTLINE },
            path: { 
              resolution: 1, 
              leadTime: 60,
              trailTime: 300,
              width: 3,
              material: color,
              show: true
            }
          })
          aircraftEntities.push(entity)
        })
      } catch (e) { console.error('Aircraft load fail:', e) }
    }
    loadAircraft()
    const aircraftInterval = setInterval(loadAircraft, 10000) // 10s refresh

    // Satellites (Celestrak TLE)
    let satEntities = []
    async function loadSatellites() {
      try {
        const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle')
        const tleLines = await res.text()
        const tles = tleLines.split('\n').filter(l => l.trim())
        satEntities.forEach(e => viewer.entities.remove(e))
        satEntities = []
        for (let i = 0; i < tles.length; i += 3) {
          const name = tles[i].trim()
          const line1 = tles[i+1]
          const line2 = tles[i+2]
          if (!line1 || !line2) continue
          const satrec = satellite.twoline2satrec(line1, line2)
          if (!satrec) continue

          const positionProperty = new Cesium.SampledPositionProperty()
          for (let j = 0; j < 3600; j += 60) { // 1 hour propagation, 1min steps
            const time = Cesium.JulianDate.now().addSeconds(j, new Cesium.JulianDate())
            const pos = satellite.propagate(satrec, time)
            if (pos) {
              positionProperty.addSample(time, Cesium.Cartesian3.fromRadians(pos.longitude, pos.latitude, pos.height * 1000))
            }
          }
          const entity = viewer.entities.add({
            availability: new Cesium.TimeIntervalCollection([new Cesium.TimeInterval({ start: Cesium.JulianDate.now(), stop: Cesium.JulianDate.now().addSeconds(3600) })]),
            position: positionProperty,
            orientation: new Cesium.VelocityOrientationProperty(positionProperty),
            path: { resolution: 60, width: 2, material: Cesium.Color.YELLOW.withAlpha(0.6), show: true },
            label: { text: name, font: '12px VT323', fillColor: Cesium.Color.YELLOW, style: Cesium.LabelStyle.FILL_AND_OUTLINE }
          })
          satEntities.push(entity)
        }
      } catch (e) { console.error('Satellites load fail:', e) }
    }
    loadSatellites()
    const satInterval = setInterval(loadSatellites, 300000) // 5min

    // Weather Radar Overlay (OpenWeather)
    if (OPENWEATHER_API_KEY !== 'YOUR_OPENWEATHER_API_KEY_HERE') {
      const weatherLayer = viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: `https://tile.openweathermap.org/map/precipitation_new/{z}/{x}/{y}.png?appid=${OPENWEATHER_API_KEY}`,
          credit: 'OpenWeatherMap'
        })
      )
      weatherLayer.alpha = 0.6
    }

    // City Selector
    const cities = {
      'Austin, TX': [-97.7431, 30.2672, 2000],
      'San Francisco, CA': [-122.4194, 37.7749, 1500],
      'New York, NY': [-74.0060, 40.7128, 3000],
      'London, UK': [-0.1278, 51.5074, 2500],
      'Tokyo, JP': [139.6503, 35.6762, 1800],
      'Paris, FR': [2.3522, 48.8566, 2200],
      'Washington DC': [-77.0369, 38.9072, 1500]
    }

    // HUD Components (in JSX below, but attach events here)
    const citySelect = document.getElementById('citySelect')
    if (citySelect) {
      citySelect.onchange = (e) => {
        const [lon, lat, alt] = cities[e.target.value]
        viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt) })
      }
    }

    // Timestamp update
    const timer = setInterval(() => {
      const now = new Date()
      const futureYear = now.getFullYear() + 1 // 2026 vibe
      setTimestamp(`${futureYear}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}Z`)
    }, 1000)

    // Presets
    const applyPreset = (p) => {
      setPreset(p)
      switch (p) {
        case 'CRT': setScanIntensity(0.4); setDistortion(0.02); setNoise(0.3); break
        case 'NVG': setScanIntensity(0.2); setDistortion(0.01); setNoise(0.1); viewer.scene.globe.material = new Cesium.Material({ fabric: { type: 'Color', uniforms: { color: new Cesium.Color(0.0, 1.0, 0.0, 0.3) } } }); break
        case 'Noir': setScanIntensity(0.1); setDistortion(0.03); setNoise(0.5); viewer.scene.globe.material = new Cesium.Material({ fabric: { type: 'Color', uniforms: { color: new Cesium.Color(0.1, 0.1, 0.1, 0.8) } } }); break
        case 'FLIR': setScanIntensity(0.3); setDistortion(0.01); setNoise(0.2); viewer.scene.globe.material = new Cesium.Material({ fabric: { type: 'Color', uniforms: { color: new Cesium.Color(1.0, 0.2, 0.0, 0.4) } } }); break
      }
      updateShader()
    }

    // Cleanup
    return () => {
      clearInterval(aircraftInterval)
      clearInterval(satInterval)
      clearInterval(timer)
      if (viewerRef.current) viewerRef.current.destroy()
    }
  }, [])

  useEffect(() => {
    if (viewerRef.current) {
      const crtStage = viewerRef.current.scene.postProcessStages._stages.find(s => s.name === 'crtShader')
      if (crtStage) {
        crtStage.uniforms.scanIntensity = scanIntensity
        crtStage.uniforms.distortion = distortion
        crtStage.uniforms.noise = noise
      }
    }
  }, [scanIntensity, distortion, noise])

  return (
    <>
      <div id="cesiumContainer" />
      <div className="hud" id="topbar">
        REC {timestamp} • MISSION: ST-TH • NOFORN • CRT ACTIVE
      </div>
      <div className="hud" id="sidebar">
        <div>City: <select id="citySelect">
          {Object.keys({ 'Austin, TX': 0, 'San Francisco, CA': 0, 'New York, NY': 0, 'London, UK': 0, 'Tokyo, JP': 0, 'Paris, FR': 0, 'Washington DC': 0 }).map(city => <option key={city}>{city}</option>)}
        </select></div>
        <br />
        <div>Style Presets:
          <button className="preset-btn" onClick={() => applyPreset('CRT')}>CRT</button>
          <button className="preset-btn" onClick={() => applyPreset('NVG')}>NVG</button>
          <button className="preset-btn" onClick={() => applyPreset('Noir')}>Noir</button>
          <button className="preset-btn" onClick={() => applyPreset('FLIR')}>FLIR</button>
        </div>
        Current: {preset}
      </div>
      <div className="hud" id="params">
        Scanlines: <input type="range" min="0" max="1" step="0.1" value={scanIntensity} onChange={(e) => setScanIntensity(parseFloat(e.target.value))} /><br />
        Distortion: <input type="range" min="0" max="0.05" step="0.01" value={distortion} onChange={(e) => setDistortion(parseFloat(e.target.value))} /><br />
        Noise: <input type="range" min="0" max="0.8" step="0.1" value={noise} onChange={(e) => setNoise(parseFloat(e.target.value))} /><br />
        <button onClick={() => { const stage = viewerRef.current?.scene.postProcessStages._stages.find(s => s.name === 'crtShader'); stage.enabled = !stage.enabled; }}>Toggle CRT</button>
      </div>
    </>
  )
}

export default App
