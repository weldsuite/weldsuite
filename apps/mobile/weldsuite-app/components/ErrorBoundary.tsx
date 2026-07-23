import React, { Component, ErrorInfo, ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { AlertCircle, RefreshCw } from 'lucide-react-native';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * ErrorBoundary Component
 *
 * Catches JavaScript errors anywhere in the child component tree,
 * logs those errors, and displays a fallback UI instead of crashing.
 *
 * Usage:
 * <ErrorBoundary>
 *   <YourComponent />
 * </ErrorBoundary>
 *
 * With custom fallback:
 * <ErrorBoundary fallback={(error, reset) => <CustomError error={error} onReset={reset} />}>
 *   <YourComponent />
 * </ErrorBoundary>
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log error to console
    console.error('ErrorBoundary caught an error:', error, errorInfo);

    // Call custom error handler if provided
    this.props.onError?.(error, errorInfo);

    // Update state with error details
    this.setState({
      error,
      errorInfo,
    });

    // TODO: Send error to error tracking service (e.g., Sentry)
    // logErrorToService(error, errorInfo);
  }

  resetError = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.resetError);
      }

      // Default fallback UI
      return (
        <View style={styles.container}>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.iconContainer}>
              <AlertCircle size={64} color="#EF4444" strokeWidth={1.5} />
            </View>

            <Text style={styles.title}>Oops! Something went wrong</Text>
            <Text style={styles.message}>
              We're sorry for the inconvenience. The app encountered an unexpected error.
            </Text>

            <View style={styles.errorContainer}>
              <Text style={styles.errorTitle}>Error Details:</Text>
              <Text style={styles.errorMessage}>{this.state.error.message}</Text>

              {__DEV__ && this.state.errorInfo && (
                <ScrollView style={styles.stackTrace} horizontal>
                  <Text style={styles.stackTraceText}>
                    {this.state.errorInfo.componentStack}
                  </Text>
                </ScrollView>
              )}
            </View>

            <TouchableOpacity style={styles.button} onPress={this.resetError}>
              <RefreshCw size={20} color="#FFFFFF" strokeWidth={2} />
              <Text style={styles.buttonText}>Try Again</Text>
            </TouchableOpacity>

            {__DEV__ && (
              <Text style={styles.devNote}>
                Development Mode: Check console for full error details
              </Text>
            )}
          </ScrollView>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  scrollContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  iconContainer: {
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
    textAlign: 'center',
  },
  message: {
    fontSize: 16,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 24,
  },
  errorContainer: {
    width: '100%',
    backgroundColor: '#FEE2E2',
    borderRadius: 12,
    padding: 16,
    marginBottom: 32,
  },
  errorTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#991B1B',
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 14,
    color: '#7F1D1D',
    lineHeight: 20,
  },
  stackTrace: {
    marginTop: 12,
    maxHeight: 150,
  },
  stackTraceText: {
    fontSize: 11,
    color: '#7F1D1D',
    fontFamily: 'monospace',
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#3B82F6',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  devNote: {
    marginTop: 24,
    fontSize: 12,
    color: '#9CA3AF',
    fontStyle: 'italic',
  },
});
