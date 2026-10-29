//! The `weldsuite` binary. One image runs every role through a subcommand:
//! `serve`, `consume`, `cron <job>`, `migrate` and the admin commands. Only
//! `version` exists so far; the roles arrive in phase P1.

use std::process::ExitCode;

const USAGE: &str = "\
usage: weldsuite <command>

commands:
  version    print the version and exit
  help       print this message and exit";

fn version() -> String {
    format!("weldsuite {}", env!("CARGO_PKG_VERSION"))
}

fn main() -> ExitCode {
    let command = std::env::args().nth(1);
    match command.as_deref() {
        Some("version" | "--version" | "-V") => {
            println!("{}", version());
            ExitCode::SUCCESS
        }
        Some("help" | "--help" | "-h") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::version;

    #[test]
    fn version_names_the_binary_and_crate_version() {
        assert_eq!(
            version(),
            format!("weldsuite {}", env!("CARGO_PKG_VERSION"))
        );
    }
}
