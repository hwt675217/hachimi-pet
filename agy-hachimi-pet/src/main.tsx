import ReactDOM from 'react-dom/client';
import { App } from './App';
import { reportRendererError } from './components/ErrorBoundary';
import './styles.css';

window.addEventListener('error', (ev) => {
  reportRendererError('window:error', ev.error || ev.message || 'Script error');
});

window.addEventListener('unhandledrejection', (ev) => {
  reportRendererError('window:unhandledrejection', ev.reason || 'Unhandled promise rejection');
});

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
