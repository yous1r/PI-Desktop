import { useTranslation } from "react-i18next";
import { IconClose, IconPlus } from "../icons";
import { TooltipButton } from "../ui";

/** Explicit process actions remain available while a shell is starting/offline. */
export function TerminalTabActions({ onNew, onClose }: {
  onNew?: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  return <>
    {onNew && <TooltipButton type="button" className="terminal-tab__restart"
      tooltip={t("panel.terminal.new")} ariaLabel={t("panel.terminal.new")}
      onClick={onNew}>
      <IconPlus size={14} />
    </TooltipButton>}
    {onClose && <TooltipButton type="button" className="terminal-tab__restart"
      tooltip={t("panel.terminal.close")} ariaLabel={t("panel.terminal.close")}
      onClick={onClose}>
      <IconClose size={14} />
    </TooltipButton>}
  </>;
}
