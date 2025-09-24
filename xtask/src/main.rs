use std::error::Error;
use std::process;

use clap::Command;
use duct::cmd;

type AnyResult<T> = Result<T, Box<dyn Error>>;
type StepFn = fn() -> AnyResult<()>;
type Step = (&'static str, StepFn);

fn cli() -> Command {
    Command::new("sightline-task")
        .about("Tasks for managing sightline codebase")
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand(
            Command::new("lint")
                .about("Lints code using native tooling")
                .subcommand_required(true)
                .arg_required_else_help(true)
                .subcommand(Command::new("rust").about("Run Rust formatters and linters"))
                .subcommand(Command::new("ts").about("Run TypeScript type checks")),
        )
        .subcommand(
            Command::new("test")
                .about("Tests code using native tooling")
                .subcommand_required(true)
                .arg_required_else_help(true)
                .subcommand(Command::new("rust").about("Run Rust tests"))
                .subcommand(Command::new("ts").about("Run TypeScript tests")),
        )
        .subcommand(Command::new("all").about("Run every lint and test"))
}

fn main() {
    if let Err(error) = run() {
        eprintln!("xtask error: {error}");
        process::exit(1);
    }
}

fn run() -> AnyResult<()> {
    let matches = cli().get_matches();

    match matches.subcommand() {
        Some(("lint", subcommand)) => match subcommand.subcommand() {
            Some(("rust", _)) => run_rust_lint(),
            Some(("ts", _)) => run_ts_lint(),
            _ => unreachable!(),
        },
        Some(("test", subcommand)) => match subcommand.subcommand() {
            Some(("rust", _)) => run_rust_tests(),
            Some(("ts", _)) => run_ts_tests(),
            _ => unreachable!(),
        },
        Some(("all", _)) => run_all(),
        _ => unreachable!(),
    }
}

fn run_rust_lint() -> AnyResult<()> {
    println!("Running Rust lint...");
    run_cmd("cargo", &["fmt", "--all"])?;
    run_cmd(
        "cargo",
        &[
            "clippy",
            "--workspace",
            "--all-targets",
            "--",
            "-D",
            "warnings",
        ],
    )?;
    Ok(())
}

fn run_ts_lint() -> AnyResult<()> {
    println!("Running TypeScript lint...");
    run_cmd("bun", &["run", "biome", "lint"])
}

fn run_rust_tests() -> AnyResult<()> {
    println!("Running Rust tests...");
    run_cmd("cargo", &["test", "--workspace"])
}

fn run_ts_tests() -> AnyResult<()> {
    println!("Running TypeScript tests...");
    run_cmd("bun", &["test"])
}

fn run_all() -> AnyResult<()> {
    let mut errors = Vec::new();

    const STEPS: &[Step] = &[
        ("Rust lint", run_rust_lint),
        ("TypeScript lint", run_ts_lint),
        ("Rust tests", run_rust_tests),
        ("TypeScript tests", run_ts_tests),
    ];

    for (label, step) in STEPS {
        if let Err(error) = step() {
            eprintln!("{label} failed: {error}");
            errors.push(format!("{label}: {error}"));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("One or more tasks failed:\n{}", errors.join("\n")).into())
    }
}

fn run_cmd(program: &str, args: &[&str]) -> AnyResult<()> {
    println!("> {} {}", program, args.join(" "));
    cmd(program, args).run()?;
    Ok(())
}
