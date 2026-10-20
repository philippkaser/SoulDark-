import '@fontsource/cinzel/400.css'
import '@fontsource/cinzel/600.css'
import '@fontsource/eb-garamond/400.css'
import '@fontsource/eb-garamond/500.css'
import '@fontsource/eb-garamond/400-italic.css'
import './ui/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PoseViewer } from './debug/PoseViewer'

const debug = new URLSearchParams(location.search).get('debug')

createRoot(document.getElementById('root')!).render(<StrictMode>{debug === 'poses' ? <PoseViewer /> : <App />}</StrictMode>)
