//! A bounded read under the existing connection owner's exclusive lock.
//! Only handoff inspection installs a progress handler on these connections;
//! their ordinary busy policy is a timeout, not a custom callback.
use rusqlite::Connection;
use std::time::{Duration, Instant};

pub fn bounded_read<T>(
    conn: &Connection,
    read: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    struct Reset<'a> {
        conn: &'a Connection,
        timeout: Duration,
        active: bool,
    }
    impl Reset<'_> {
        fn restore(&mut self) -> rusqlite::Result<()> {
            self.conn.progress_handler(0, None::<fn() -> bool>)?;
            self.conn.busy_timeout(self.timeout)?;
            self.active = false;
            Ok(())
        }
    }
    impl Drop for Reset<'_> {
        fn drop(&mut self) {
            if self.active {
                if let Err(error) = self.restore() {
                    tracing::error!(%error, "could not restore database read policy");
                }
            }
        }
    }
    let timeout: u32 = conn.query_row("PRAGMA busy_timeout", [], |row| row.get(0))?;
    conn.busy_timeout(Duration::ZERO)?;
    let mut reset = Reset {
        conn,
        timeout: Duration::from_millis(u64::from(timeout)),
        active: true,
    };
    let started = Instant::now();
    let mut ticks = 0_u32;
    conn.progress_handler(
        1000,
        Some(move || {
            ticks += 1;
            ticks >= 100 || started.elapsed() >= Duration::from_millis(100)
        }),
    )?;
    let result = read();
    reset.restore()?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_scan_refuses_and_restores_the_connection() {
        let conn = Connection::open_in_memory().unwrap();
        conn.busy_timeout(Duration::from_millis(1234)).unwrap();
        let scan = || -> anyhow::Result<i64> {
            Ok(conn.query_row("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) SELECT sum(x) FROM n", [], |row| row.get(0))?)
        };
        assert!(bounded_read(&conn, scan).is_err());
        assert_eq!(scan().unwrap(), 5_000_050_000);
        assert_eq!(
            conn.query_row("PRAGMA busy_timeout", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            1234
        );
        assert_eq!(
            bounded_read(&conn, || Ok(
                conn.query_row("SELECT 7", [], |row| row.get::<_, i64>(0))?
            ))
            .unwrap(),
            7
        );
    }

    #[test]
    fn unwind_restores_the_original_database_policy() {
        let conn = Connection::open_in_memory().unwrap();
        conn.busy_timeout(Duration::from_millis(4321)).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = bounded_read::<()>(&conn, || panic!("fixture read failure"));
        }));
        assert!(result.is_err());
        assert_eq!(
            conn.query_row("PRAGMA busy_timeout", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            4321
        );
        let count: i64 = conn.query_row(
            "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) SELECT count(*) FROM n",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 100_000);
    }

    #[test]
    fn locked_database_refuses_without_consuming_the_ordinary_busy_timeout() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("read.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch("CREATE TABLE sample(n); INSERT INTO sample VALUES(1);")
            .unwrap();
        let reader = Connection::open(&path).unwrap();
        reader.busy_timeout(Duration::from_secs(10)).unwrap();
        writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let started = Instant::now();
        assert!(bounded_read(&reader, || Ok(reader.query_row(
            "SELECT n FROM sample",
            [],
            |row| row.get::<_, i64>(0)
        )?))
        .is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        writer.execute_batch("ROLLBACK").unwrap();
        assert_eq!(
            reader
                .query_row("PRAGMA busy_timeout", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            10_000
        );
    }
}
