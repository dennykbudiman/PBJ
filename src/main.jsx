import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './context/AuthContext'
import { ShopProvider } from './context/ShopContext'
import { LangProvider } from './lib/i18n'
import { ToastProvider } from './components/ui'
import ErrorBoundary from './components/ErrorBoundary'
import './styles.css'
import { applyTheme, storedTheme } from './lib/theme'

// Show the last theme straight away (also on the sign-in page); the shop's saved theme follows once loaded.
applyTheme(storedTheme())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ShopProvider>
          <LangProvider>
            <ToastProvider>
              <ErrorBoundary>
                <App />
              </ErrorBoundary>
            </ToastProvider>
          </LangProvider>
        </ShopProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
