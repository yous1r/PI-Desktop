use std::{env, path::PathBuf, process::ExitCode};

use pi_helper::{run, HelperConfig};

fn main() -> ExitCode {
    match run_cli() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pi-helper: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run_cli() -> Result<(), String> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("version") | Some("--version") | Some("-V") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("serve") => {
            if !cfg!(target_os = "linux") {
                return Err("pi-helper serve supports Linux remote targets only".to_string());
            }
            if !cfg!(target_os = "linux") {
                return Err("pi-helper serve supports Linux remote targets only".to_string());
            }
            let mut port = 0u16;
            let mut root = None;
            let mut project_roots = Vec::new();
            while let Some(flag) = args.next() {
                let value = args.next().ok_or_else(|| format!("missing value for {flag}"))?;
                match flag.as_str() {
                    "--port" => {
                        port = value.parse().map_err(|_| "invalid port".to_string())?;
                    }
                    "--root" => root = Some(PathBuf::from(value)),
                    "--project-root" => project_roots.push(PathBuf::from(value)),
                    _ => return Err(format!("unknown option: {flag}")),
                }
            }
            let root = root.ok_or_else(|| "--root is required".to_string())?;
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|_| "runtime initialization failed".to_string())?;
            runtime
                .block_on(run(HelperConfig { port, root, project_roots }))
                .map_err(|error| error.to_string())
        }
        _ => Err("usage: pi-helper version | serve --root <path> [--port <port>] [--project-root <path>]...".to_string()),
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn usage_names_only_supported_commands() {
        let usage = "usage: pi-helper version | serve --root <path> [--port <port>] [--project-root <path>]...";
        assert!(usage.contains("version"));
        assert!(usage.contains("serve"));
    }
}
