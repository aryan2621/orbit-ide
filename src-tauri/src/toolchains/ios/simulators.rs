//! Simulator management for the Device Manager: list what can be created, create, boot, shut
//! down, erase and delete Simulators (all through `simctl`).

use crate::env;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize)]
pub struct Choice {
    pub id: String,
    pub name: String,
}

/// Device types (iPhone 17, iPad Air…) and installed iOS runtimes a Simulator can be created from.
#[derive(Serialize, Default)]
pub struct SimulatorOptions {
    #[serde(rename = "deviceTypes")]
    pub device_types: Vec<Choice>,
    pub runtimes: Vec<Choice>,
}

async fn simctl(args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = env::command("xcrun");
    cmd.arg("simctl").args(args).kill_on_drop(true);
    let out = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| format!("simctl {} timed out", args.first().unwrap_or(&"")))?
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

#[tauri::command]
pub async fn ios_simulator_options() -> Result<SimulatorOptions, String> {
    let json = |s: String| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string());
    let types = json(simctl(&["list", "devicetypes", "-j"], Duration::from_secs(20)).await?)?;
    let runtimes = json(simctl(&["list", "runtimes", "available", "-j"], Duration::from_secs(20)).await?)?;
    let device_types = types["devicetypes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["productFamily"].as_str().is_some_and(|f| f == "iPhone" || f == "iPad"))
        .filter_map(|t| Some(Choice { id: t["identifier"].as_str()?.into(), name: t["name"].as_str()?.into() }))
        .rev() // newest models are listed last
        .collect();
    let runtimes = runtimes["runtimes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["platform"].as_str() == Some("iOS") && r["isAvailable"].as_bool() != Some(false))
        .filter_map(|r| Some(Choice { id: r["identifier"].as_str()?.into(), name: r["name"].as_str()?.into() }))
        .rev()
        .collect();
    Ok(SimulatorOptions { device_types, runtimes })
}

/// Creates a Simulator and returns its UDID.
#[tauri::command]
pub async fn ios_simulator_create(name: String, device_type: String, runtime: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the Simulator a name".into());
    }
    simctl(&["create", name, &device_type, &runtime], Duration::from_secs(60)).await
}

/// `boot`, `shutdown`, `erase` (wipe content and settings) or `delete`.
#[tauri::command]
pub async fn ios_simulator_action(udid: String, action: String) -> Result<(), String> {
    match action.as_str() {
        "boot" => match simctl(&["boot", &udid], Duration::from_secs(120)).await {
            Err(e) if !e.contains("Booted") => Err(e),
            _ => Ok(()),
        },
        "shutdown" => match simctl(&["shutdown", &udid], Duration::from_secs(60)).await {
            Err(e) if !e.contains("Shutdown") => Err(e),
            _ => Ok(()),
        },
        "erase" => {
            // Erasing needs the device shut down.
            let _ = simctl(&["shutdown", &udid], Duration::from_secs(60)).await;
            simctl(&["erase", &udid], Duration::from_secs(120)).await.map(|_| ())
        }
        "delete" => {
            let _ = simctl(&["shutdown", &udid], Duration::from_secs(60)).await;
            simctl(&["delete", &udid], Duration::from_secs(60)).await.map(|_| ())
        }
        other => Err(format!("Unknown action: {other}")),
    }
}
