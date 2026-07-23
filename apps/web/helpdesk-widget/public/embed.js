/**
 * Helpdesk Widget Embed Script
 * This script creates an iframe and loads the widget
 */

(function () {
  'use strict';

  // Prevent multiple instances
  if (window.HelpdeskWidget) {
    console.warn('Helpdesk widget already loaded');
    return;
  }

  // Default configuration
  const defaultConfig = {
    apiUrl: 'http://localhost:3100',
    position: 'bottom-right',
    theme: 'light',
    primaryColor: '#3b82f6',
  };

  // Merge with user config
  const config = {
    ...defaultConfig,
    ...(window.helpdeskConfig || {}),
  };

  // Create iframe container
  function createWidget() {
    const container = document.createElement('div');
    container.id = 'helpdesk-widget-container';
    container.style.cssText = `
      position: fixed;
      z-index: 9999;
      pointer-events: none;
    `;

    // Position based on config
    const positions = {
      'bottom-right': 'bottom: 0; right: 0;',
      'bottom-left': 'bottom: 0; left: 0;',
      'top-right': 'top: 0; right: 0;',
      'top-left': 'top: 0; left: 0;',
    };
    container.style.cssText += positions[config.position] || positions['bottom-right'];

    // Create iframe
    const iframe = document.createElement('iframe');
    iframe.id = 'helpdesk-widget-iframe';
    iframe.style.cssText = `
      border: none;
      width: 100vw;
      height: 100vh;
      pointer-events: auto;
      background: transparent;
    `;

    // Build iframe URL with config params
    const params = new URLSearchParams({
      position: config.position,
      color: config.primaryColor,
      theme: config.theme,
    });

    // Add optional params
    if (config.conversationId) params.append('conversationId', config.conversationId);
    if (config.customerName) params.append('customerName', config.customerName);
    if (config.customerEmail) params.append('customerEmail', config.customerEmail);

    iframe.src = `${config.apiUrl}/widget?${params.toString()}`;

    container.appendChild(iframe);
    document.body.appendChild(container);

    return { container, iframe };
  }

  // Initialize widget when DOM is ready
  function initialize() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', createWidget);
    } else {
      createWidget();
    }
  }

  // Public API
  window.HelpdeskWidget = {
    config: config,
    show: function () {
      const container = document.getElementById('helpdesk-widget-container');
      if (container) container.style.display = 'block';
    },
    hide: function () {
      const container = document.getElementById('helpdesk-widget-container');
      if (container) container.style.display = 'none';
    },
    destroy: function () {
      const container = document.getElementById('helpdesk-widget-container');
      if (container) container.remove();
    },
    updateConfig: function (newConfig) {
      Object.assign(config, newConfig);
      this.destroy();
      initialize();
    },
  };

  // Auto-initialize
  initialize();

  console.log('Helpdesk widget loaded');
})();
