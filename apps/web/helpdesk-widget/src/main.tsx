import React from 'react';
import ReactDOM from 'react-dom/client';
// First: listens for the SDK's weld:init (with the visitor's identity) before React mounts.
import './lib/sdk-bridge';
import { App } from './App';
import './styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
