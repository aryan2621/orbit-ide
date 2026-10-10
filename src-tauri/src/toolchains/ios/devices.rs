//! iOS Simulators (simctl) and connected iPhones/iPads (devicectl).

use crate::env;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    Simulator,
    Device,
}

#[derive(Serialize, Clone, Debug)]
pub struct Device {
    /// UDID: what xcodebuild, simctl and devicectl all accept.
    pub id: String,
    pub name: String,
    pub kind: DeviceKind,
    /// e.g. "iOS 18.2"
    pub os: String,
    pub booted: bool,
}

impl Device {
    pub fn destination(&self) -> String {
        match self.kind {
            DeviceKind::Simulator => format!("platform=iOS Simulator,id={}", self.id),
            DeviceKind::Device => format!("platform=iOS,id={}", self.id),
        }
    }
}

/// `com.apple.CoreSimulator.SimRuntime.iOS-18-2` → `iOS 18.2`
fn runtime_name(key: &str) -> Option<String> {
    let rt = key.rsplit('.').next()?;
    let (platform, version) = rt.split_once('-')?;
    Some(format!("{platform} {}", version.replace('-', ".")))
}

pub fn parse_simulators(json: &Value) -> Vec<Device> {
    let mut out = Vec::new();
    for (runtime, devices) in json["devices"].as_object().into_iter().flatten() {
        let Some(os) = runtime_name(runtime) else { continue };
        if !os.starts_with("iOS") {
            continue;
        }
        for d in devices.as_array().into_iter().flatten() {
            if d["isAvailable"].as_bool() == Some(false) {
                continue;
            }
            let (Some(id), Some(name)) = (d["udid"].as_str(), d["name"].as_str()) else { continue };
            out.push(Device {
                id: id.into(),
                name: name.into(),
                kind: DeviceKind::Simulator,
                os: os.clone(),
                booted: d["state"].as_str() == Some("Booted"),
            });
        }
    }
    // Newest OS first, then by name.
    out.sort_by(|a, b| version_key(&b.os).cmp(&version_key(&a.os)).then_with(|| a.name.cmp(&b.name)));
    out
}

fn version_key(os: &str) -> Vec<u32> {
    os.split_whitespace().last().unwrap_or("").split('.').filter_map(|p| p.parse().ok()).collect()
}

pub fn parse_physical(json: &Value) -> Vec<Device> {
    json["result"]["devices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| d["hardwareProperties"]["platform"].as_str() == Some("iOS"))
        .filter(|d| d["connectionProperties"]["pairingState"].as_str() == Some("paired"))
        .filter_map(|d| {
            let id = d["hardwareProperties"]["udid"].as_str()?;
            Some(Device {
                id: id.into(),
                name: d["deviceProperties"]["name"].as_str().unwrap_or("iPhone").into(),
                kind: DeviceKind::Device,
                os: format!("iOS {}", d["deviceProperties"]["osVersionNumber"].as_str().unwrap_or("")).trim().into(),
                booted: d["connectionProperties"]["tunnelState"].as_str() != Some("unavailable"),
            })
        })
        .collect()
}

async fn simulators() -> Vec<Device> {
    let out = env::command("xcrun").args(["simctl", "list", "devices", "available", "-j"]).output().await;
    match out {
        Ok(o) if o.status.success() => parse_simulators(&serde_json::from_slice(&o.stdout).unwrap_or_default()),
        _ => vec![],
    }
}

async fn physical_devices() -> Vec<Device> {
    // devicectl only writes JSON to a file.
    let path = std::env::temp_dir().join(format!("orbit-devices-{}.json", std::process::id()));
    let ok = env::command("xcrun")
        .args(["devicectl", "list", "devices", "--quiet", "--json-output"])
        .arg(&path)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    let json = if ok { std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()) } else { None };
    let _ = std::fs::remove_file(&path);
    json.map(|j| parse_physical(&j)).unwrap_or_default()
}

pub async fn list() -> Vec<Device> {
    let (mut devices, sims) = tokio::join!(physical_devices(), simulators());
    devices.extend(sims);
    devices
}

#[tauri::command]
pub async fn ios_devices() -> Vec<Device> {
    list().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_simulators_newest_first() {
        let j = json!({ "devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
                { "udid": "A", "name": "iPhone 15", "state": "Shutdown", "isAvailable": true }
            ],
            "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
                { "udid": "B", "name": "iPhone 16", "state": "Booted", "isAvailable": true },
                { "udid": "C", "name": "Broken", "state": "Shutdown", "isAvailable": false }
            ],
            "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [
                { "udid": "W", "name": "Watch", "state": "Shutdown", "isAvailable": true }
            ]
        }});
        let d = parse_simulators(&j);
        assert_eq!(d.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["B", "A"]);
        assert_eq!(d[0].os, "iOS 18.2");
        assert!(d[0].booted);
        assert_eq!(d[0].destination(), "platform=iOS Simulator,id=B");
    }

    #[test]
    fn parses_paired_ios_devices() {
        let j = json!({ "result": { "devices": [
            { "hardwareProperties": { "platform": "iOS", "udid": "00008110-X" },
              "deviceProperties": { "name": "Rishabh's iPhone", "osVersionNumber": "18.1" },
              "connectionProperties": { "pairingState": "paired", "tunnelState": "connected" } },
            { "hardwareProperties": { "platform": "watchOS", "udid": "W" },
              "deviceProperties": { "name": "Watch" },
              "connectionProperties": { "pairingState": "paired" } },
            { "hardwareProperties": { "platform": "iOS", "udid": "U" },
              "deviceProperties": { "name": "Unpaired" },
              "connectionProperties": { "pairingState": "unpaired" } }
        ]}});
        let d = parse_physical(&j);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].name, "Rishabh's iPhone");
        assert_eq!(d[0].os, "iOS 18.1");
        assert_eq!(d[0].destination(), "platform=iOS,id=00008110-X");
    }
}
