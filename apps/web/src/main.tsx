import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppProviders } from './lib/providers';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/toast';
import { AppRouter } from './router';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AppProviders>
        <ToastProvider>
          <AppRouter />
        </ToastProvider>
      </AppProviders>
    </ThemeProvider>
  </React.StrictMode>,
);
