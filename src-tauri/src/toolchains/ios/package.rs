//! Swift packages build and run natively on the Mac with SwiftPM — no Xcode needed.

use crate::env;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Product {
    pub name: String,
    pub executable: bool,
}

pub fn parse_products(json: &Value) -> Vec<Product> {
    json["products"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            Some(Product {
                name: p["name"].as_str()?.to_owned(),
                executable: p["type"].get("executable").is_some(),
            })
        })
        .collect()
}

/// Products declared in Package.swift (`swift package describe`).
pub async fn products(dir: &str) -> Result<Vec<Product>, String> {
    let out = env::command("swift")
        .args(["package", "describe", "--type", "json"])
        .current_dir(dir)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().find(|l| l.contains("error")).unwrap_or("Could not read Package.swift").trim().to_owned());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let json: Value = stdout.find('{').and_then(|i| serde_json::from_str(&stdout[i..]).ok()).unwrap_or_default();
    Ok(parse_products(&json))
}

fn swift_config(configuration: &str) -> &'static str {
    if configuration.eq_ignore_ascii_case("release") {
        "release"
    } else {
        "debug"
    }
}

pub fn build_command(dir: &str, product: &str, configuration: &str) -> tokio::process::Command {
    let mut cmd = env::command("swift");
    cmd.args(["build", "--product", product, "-c", swift_config(configuration)]).current_dir(dir);
    cmd
}

/// Path of a built executable product.
pub async fn executable_path(dir: &str, product: &str, configuration: &str) -> Result<String, String> {
    let out = env::command("swift")
        .args(["build", "-c", swift_config(configuration), "--show-bin-path"])
        .current_dir(dir)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let bin = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if !out.status.success() || bin.is_empty() {
        return Err("Could not find the build folder".into());
    }
    Ok(format!("{bin}/{product}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_products() {
        let j = json!({ "products": [
            { "name": "Tool", "type": { "executable": null } },
            { "name": "Kit", "type": { "library": ["automatic"] } }
        ]});
        assert_eq!(
            parse_products(&j),
            [Product { name: "Tool".into(), executable: true }, Product { name: "Kit".into(), executable: false }]
        );
    }
}
