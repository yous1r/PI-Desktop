//! Durable release intent requests the existing RPC cleanup path. This signal
//! is never evidence of process exit or data-directory lock release.
#[derive(Clone)]
pub(crate) struct Release(tokio::sync::watch::Sender<bool>);
impl Default for Release {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(false).0)
    }
}
impl Release {
    pub(super) fn request(&self) {
        self.0.send_replace(true);
    }
    pub async fn requested(&self) {
        let mut receiver = self.0.subscribe();
        if *receiver.borrow_and_update() {
            return;
        }
        let _ = receiver.wait_for(|value| *value).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn release_is_retained_before_and_after_rpc_subscribes() {
        let signal = Release::default();
        let waiter = signal.clone();
        let task = tokio::spawn(async move {
            waiter.requested().await;
        });
        signal.request();
        task.await.unwrap();
        signal.requested().await;
        signal.request();
        signal.requested().await;
    }
}
