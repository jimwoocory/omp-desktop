import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

class WorkbenchBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Workbench render failure', error, info.componentStack); }
  render() {
    if (this.state.error) return <main className="fatal-error"><h1>工作台遇到错误</h1><p>{this.state.error}</p><button onClick={() => window.location.reload()}>重新加载</button></main>;
    return this.props.children;
  }
}
const container = document.getElementById('root');
if (!container) throw new Error('Desktop root element is missing');
createRoot(container).render(<WorkbenchBoundary><App /></WorkbenchBoundary>);
