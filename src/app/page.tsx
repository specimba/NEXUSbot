import { I18nProvider } from "@/lib/i18n";
import { PanelApp } from "@/components/panel/panel-app";

export default function Home() {
  return (
    <I18nProvider>
      <PanelApp />
    </I18nProvider>
  );
}
