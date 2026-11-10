import { bindOwnerHandoffExchange } from "@pi-desktop/host-runtime";
import type { HostProcess } from "../host-process";
import type { DesktopHandoffAdmission } from "./handoff-admission";
import { DesktopHandoffCoordinator, type DesktopHandoffOwners } from "./handoff-coordinator";

/** Application lifetime is separate from any one ordinary backend lifetime. */
export function createDesktopHandoffService(admission: DesktopHandoffAdmission,
  current: () => DesktopHandoffOwners | null, currentHost: () => DesktopHandoffOwners["host"] | null) {
  const coordinator = new DesktopHandoffCoordinator(admission, current);
  let binding: { host: HostProcess; channel: ReturnType<typeof bindOwnerHandoffExchange> } | undefined;
  let disposed = false;
  return {
    wireHost(host: HostProcess): void {
      if (disposed || binding?.host === host) return;
      binding?.channel.dispose();
      const channel = bindOwnerHandoffExchange({ host,
        isCurrent: () => !disposed && currentHost() === host,
        exchange: (notification, assertCurrent) => coordinator.exchange(notification.request,
          { host, profileId: notification.profileId, assertCurrent }),
        unavailable: () => coordinator.channelUnavailable(host),
      });
      binding = { host, channel };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      coordinator.dispose();
      binding?.channel.dispose();
      binding = undefined;
    },
  };
}
