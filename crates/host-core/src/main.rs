mod activation;
mod agent_capabilities;
mod artifacts;
mod audit;
mod background_tasks;
mod config_sync;
mod data_directory_owner;
mod data_relocation;
mod db;
mod execution_fence;
mod keyboard;
mod mcp_servers;
mod mode_runs;
mod network_policy;
mod network_proxy;
mod notifications;
mod owner_control;
mod owner_handoff;
mod permissions;
mod personal_todos;
mod plans;
mod plugin_sessions;
mod plugin_usage;
mod plugins;
mod providers;
mod review;
mod rpc;
mod scheduled;
mod scratch;
mod secrets;
mod session_collaboration;
mod session_search;
mod session_worktrees;
mod sessions;
mod state;
mod todos;
mod tool_budget;
mod tools;
mod transcripts;
mod turn_queue;
mod user_skills;
mod user_subagents;
mod visualizations;
mod workspace;

use std::sync::Arc;
use tokio::sync::Mutex;
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> anyhow::Result<()> {
    // Locals drop in reverse order: Tokio must stop every background/blocking
    // task before the data-directory ownership handle can be released.
    let mut data_owner = None;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run(&mut data_owner))
}

async fn run(
    data_owner: &mut Option<data_directory_owner::DataDirectoryOwner>,
) -> anyhow::Result<()> {
    if let Some(code) = execution_fence::run_cli().await? {
        std::process::exit(code);
    }
    owner_handoff::validate_cli()?;
    owner_control::validate_cli()?;
    if data_relocation::run_cli()? {
        return Ok(());
    }
    if std::env::args().any(|arg| arg == tools::INTERNAL_TOOL_RUNNER_FLAG) {
        let exit_code = match tools::run_internal_tool_runner().await {
            Ok(exit_code) => exit_code,
            Err(error) => {
                eprintln!("internal tool runner failed: {error:#}");
                1
            }
        };
        std::process::exit(exit_code);
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let data_dir = std::env::var("PI_DESKTOP_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".pi-desktop")
        });
    if owner_control::query_cli(&data_dir).await? {
        return Ok(());
    }
    if owner_handoff::run_cli(&data_dir, data_owner).await? {
        return Ok(());
    }

    std::fs::create_dir_all(&data_dir)?;
    // Hold through shutdown: a losing startup must not migrate or recover a
    // database that still belongs to another Desktop/headless Host.
    *data_owner = Some(data_directory_owner::DataDirectoryOwner::acquire(
        &data_dir,
    )?);
    let prior_owner = owner_handoff::startup::inspect_directory(&data_dir)?;
    let mut execution_fence = execution_fence::start(&data_dir)?;
    let owner_control =
        owner_control::Control::start(&data_dir, execution_fence::owner_epoch(&execution_fence))?;
    prior_owner.commit()?;
    std::fs::create_dir_all(data_dir.join("logs"))?;
    std::fs::create_dir_all(data_dir.join("plugins/installed"))?;
    std::fs::create_dir_all(data_dir.join("plugins/data"))?;
    std::fs::create_dir_all(data_dir.join("plugins/market"))?;
    std::fs::create_dir_all(data_dir.join("plugins/cache/download"))?;
    std::fs::create_dir_all(data_dir.join("cache"))?;
    std::fs::create_dir_all(data_dir.join("scratch"))?;

    let mut app_state = AppState::open(&data_dir)?;
    execution_fence::bind_journal(&mut execution_fence, &data_dir)?;
    app_state.execution_fence = execution_fence;
    let state = Arc::new(Mutex::new(app_state));
    tracing::info!(path = %data_dir.display(), "host-core starting");
    {
        // Sweep orphaned/stale session scratch dirs left behind by crashes or
        // deletions that bypassed session.delete (D114).
        let st = state.lock().await;
        // Only sweep with a real session list: an empty fallback on a db
        // error would wipe scratch dirs of sessions that still exist.
        if let Ok(list) = sessions::list_sessions(&st.db) {
            let live: std::collections::HashSet<String> = list.into_iter().map(|s| s.id).collect();
            scratch::sweep(&data_dir, &live);
            // Visualization dirs are swept for orphans only, never by age
            // (D671): live transcripts still reference their cards.
            visualizations::sweep(&data_dir, &live);
            review::sweep(&data_dir, &live);
        }
    }
    // Drop half-created worktrees, mark vanished ones, repair links after a
    // moved data directory, and remove orphans (ADR 0329).
    let startup = state
        .lock()
        .await
        .handoff_activity
        .begin(owner_handoff::activity::Kind::Background);
    let startup_state = state.clone();
    tokio::spawn(async move {
        session_worktrees::lifecycle::reconcile(
            startup_state,
            session_worktrees::git::GitRunner::default(),
        )
        .await;
        startup.finish(true);
    });
    owner_control.serve(rpc::serve(state)).await
}
