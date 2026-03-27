import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="klv-card p-8 text-center max-w-lg mx-auto mt-12">
          <div className="text-3xl mb-4">⚠</div>
          <h2 className="text-lg font-display font-bold text-klv-text mb-2">
            Algo salió mal
          </h2>
          <p className="text-sm text-klv-text-muted mb-4 font-mono break-all">
            {this.state.error?.message ?? 'Error desconocido'}
          </p>
          <button
            onClick={this.handleReset}
            className="klv-btn-primary"
          >
            Reintentar
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
