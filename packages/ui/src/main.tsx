import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/manrope'
import '@fontsource-variable/newsreader'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
