use clap::Parser;
use importer::{Cli, run};

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    run(cli)
}
