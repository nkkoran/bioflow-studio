import type { BioflowAPI } from './index'

declare global {
  interface Window {
    api: BioflowAPI
  }
}
