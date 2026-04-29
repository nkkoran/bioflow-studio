import type { DnxInstanceSpec } from '@/types/dnx'

export const SPARK_INSTANCE_TYPES: DnxInstanceSpec[] = [
  { id: 'mem1_ssd1_v2_x2', name: 'mem1_ssd1_v2_x2', cpu: 2, memoryGB: 16, localSsdGB: 40 },
  { id: 'mem1_ssd1_v2_x4', name: 'mem1_ssd1_v2_x4', cpu: 4, memoryGB: 32, localSsdGB: 80 },
  { id: 'mem1_ssd1_v2_x8', name: 'mem1_ssd1_v2_x8', cpu: 8, memoryGB: 64, localSsdGB: 160 },
  { id: 'mem1_ssd1_v2_x16', name: 'mem1_ssd1_v2_x16', cpu: 16, memoryGB: 128, localSsdGB: 320 },
]

