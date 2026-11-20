import React from 'react';

interface ErrorBoundaryProps {
  name: string;
  bridgePort?: number;
  autoRecoverMs?: number;
  fallback?: React.ReactNode | ((reset: () => void, error: Error) => React.ReactNode);
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export function reportRendererError(source: string, err: unknown, bridgePort?: number) {
  const port = bridgePort || window.petHost?.bridgePort || 17890;
  const message = err instanceof Error ? err.message : String(err || 'Unknown renderer error');
  const stack = err instanceof Error && err.stack ? err.stack : '';
  try {
    fetch(`http://127.0.0.1:${port}/api/renderer-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'error', source, message, stack }),
    }).catch(() => {});
  } catch {
    // ignore reporting failures
  }
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private recoverTimer: number | null = null;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportRendererError(
      `react:${this.props.name}`,
      new Error(`${error.message}${info?.componentStack ? `\n${info.componentStack}` : ''}`),
      this.props.bridgePort
    );

    if (this.props.autoRecoverMs && this.props.autoRecoverMs > 0) {
      if (this.recoverTimer !== null) {
        window.clearTimeout(this.recoverTimer);
      }
      this.recoverTimer = window.setTimeout(() => {
        this.recoverTimer = null;
        this.setState({ error: null });
      }, this.props.autoRecoverMs);
    }
  }

  componentWillUnmount() {
    if (this.recoverTimer !== null) {
      window.clearTimeout(this.recoverTimer);
      this.recoverTimer = null;
    }
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.reset, this.state.error);
      }
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
