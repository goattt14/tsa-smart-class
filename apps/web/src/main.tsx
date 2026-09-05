import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth/AuthProvider';
import { applyBranding } from './config/branding';
import { queryClient } from './lib/query-client';
import './styles/index.css';

// Branding is applied before the first paint so the institute's colours are
// in place rather than flashing from the defaults.
applyBranding();

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
