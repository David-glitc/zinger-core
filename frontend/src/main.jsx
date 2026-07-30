import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import PolyDashboard from './PolyDashboard.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <PolyDashboard />
  </StrictMode>,
)
