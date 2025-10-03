"use client"

import { useMemo } from 'react'

interface AnalyticsSparklineProps {
  values: number[]
  width?: number
  height?: number
  stroke?: string
  fill?: string
}

export default function AnalyticsSparkline({
  values,
  width = 120,
  height = 36,
  stroke = 'rgba(46,230,214,0.8)',
  fill = 'rgba(46,230,214,0.12)',
}: AnalyticsSparklineProps) {
  const path = useMemo(() => {
    if (!values || values.length === 0) return ''
    const max = Math.max(...values)
    const min = Math.min(...values)
    const range = max - min || 1
    const step = width / (values.length - 1 || 1)
    const points = values.map((value, index) => {
      const x = index * step
      const normalized = (value - min) / range
      const y = height - normalized * height
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    const areaPoints = [`0,${height}`, ...points, `${width},${height}`]
    return areaPoints.join(' ')
  }, [height, values, width])

  const linePath = useMemo(() => {
    if (!values || values.length === 0) return ''
    const max = Math.max(...values)
    const min = Math.min(...values)
    const range = max - min || 1
    const step = width / (values.length - 1 || 1)
    return values
      .map((value, index) => {
        const x = index * step
        const normalized = (value - min) / range
        const y = height - normalized * height
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
      })
      .join(' ')
  }, [height, values, width])

  if (!values || values.length === 0) {
    return <div className="h-9" />
  }

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <polyline points={path} fill={fill} stroke="none" />
      <path d={linePath} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
