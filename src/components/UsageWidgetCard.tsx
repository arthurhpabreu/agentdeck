import { useAppI18n } from "../i18n";
import { RefreshCw } from "lucide-react";
import { usageMessages } from "../i18n/usageMessages";
import { useProviderUsage } from "../store/providerUsageStore";
import { ProviderUsageDetails } from "./ProviderUsageBar";

export function UsageWidgetCard() {
  const { locale } = useAppI18n();
  const copy = usageMessages[locale];
  const { providers, refreshing, refresh, checkedAt } = useProviderUsage();
  return <div className="usage-widget">
    <div className="usage-widget-heading"><span>{copy.title}</span><button type="button" className="usage-refresh" onClick={() => void refresh(true)} disabled={refreshing} aria-busy={refreshing} title={copy.refresh} aria-label={copy.refresh}><RefreshCw size={14} className={refreshing ? "is-spinning" : ""} /></button></div>
    {providers.map((provider) => <ProviderUsageDetails key={provider.provider} provider={provider} checkedAt={checkedAt} checking={refreshing && checkedAt === null} />)}
  </div>;
}
