import { Component, type ReactNode } from "react";

export function StartupError({ error }: { error: unknown }) {
  const locale = navigator.language;
  const pt = locale.startsWith("pt"); const es = locale.startsWith("es");
  return <div style={{ minHeight: "100vh", padding: 32, display: "grid", placeItems: "center", background: "#131c19", color: "#e8f1eb" }}><div style={{ maxWidth: 560 }}>
    <img src="/agentdeck-icon.png" width="64" height="64" alt="Agentdeck" />
    <h1 style={{ fontSize: 24, margin: "18px 0 10px" }}>{pt ? "Vamos recuperar seu workspace" : es ? "Recuperemos tu espacio de trabajo" : "Let's recover your workspace"}</h1>
    <p style={{ lineHeight: 1.7 }}>{pt ? "A interface encontrou um problema. Recarregue para tentar novamente. Seus projetos e conversas salvas continuam neste dispositivo." : es ? "La interfaz encontró un problema. Recarga para reintentar. Tus proyectos y conversaciones guardadas siguen en este dispositivo." : "The interface encountered a problem. Reload to try again. Your projects and saved conversations are still on this device."}</p>
    <button className="ad-button ad-button-primary" style={{ margin: "18px 0" }} onClick={() => window.location.reload()}>{pt ? "Recarregar aplicativo" : es ? "Recargar aplicación" : "Reload app"}</button>
    <details><summary>{pt ? "Detalhes" : es ? "Detalles" : "Details"}</summary><pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 10 }}>{String(error)}</pre></details>
  </div></div>;
}
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() { return this.state.error ? <StartupError error={this.state.error} /> : this.props.children; }
}
