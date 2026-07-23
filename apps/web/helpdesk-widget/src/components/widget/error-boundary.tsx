import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Weld Widget] Render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: '24px',
            textAlign: 'center',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <p style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 8px' }}>
            Something went wrong
          </p>
          <p style={{ fontSize: '13px', color: '#6b7280', margin: '0 0 16px' }}>
            The widget encountered an error.
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
