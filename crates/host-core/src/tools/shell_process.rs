//! Construct a shell process once for production runners and test builds.
use std::path::Path;
use tokio::process::Command;

pub(super) fn command(program: &Path, args: &[String]) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    if program
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"))
    {
        if let Some((script, flags)) = args.split_last() {
            // cmd parses /C as a command line, not a C-runtime argv string.
            // /S removes our outer quotes; preserve the user's inner quotes,
            // operators and redirections exactly after normal tool approval.
            command.args(flags).raw_arg(format!("\"{script}\""));
            return command;
        }
    }
    command.args(args);
    command
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::tools::shell;
    use std::time::Duration;

    #[tokio::test]
    async fn cmd_preserves_quoted_paths_metacharacters_unicode_and_exit_code() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("cwd space π & files");
        std::fs::create_dir_all(&workspace).unwrap();
        let input = workspace.join("quoted & input.txt");
        let output = workspace.join("quoted & output.txt");
        std::fs::write(&input, "payload π\n").unwrap();
        let shell = shell::resolve_shell(shell::CMD_ID).unwrap();
        let script = format!(
            "type \"{}\" > \"{}\" && echo literal ^& marker && exit /b 7",
            input.display(),
            output.display()
        );
        let invocation = shell::build_invocation_for_platform(
            shell::ShellPlatform::Windows,
            shell::CMD_ID,
            shell.program,
            &script,
        )
        .unwrap();
        let mut child = command(&invocation.program, &invocation.args);
        child.current_dir(&workspace).kill_on_drop(true);
        let result = tokio::time::timeout(Duration::from_secs(5), child.output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            result.status.code(),
            Some(7),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            std::fs::read(&output).unwrap(),
            std::fs::read(&input).unwrap()
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("literal & marker"));
        assert!(result.stderr.is_empty());
    }
}
