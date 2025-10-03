"use client"
import { useEffect, useRef } from 'react'
import * as THREE from 'three'

export default function AuthPreview3D({ height = 300 }: { height?: number }) {
  const mountRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const mount = mountRef.current!
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    mount.appendChild(renderer.domElement)

    const amb = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(amb)
    const dir = new THREE.DirectionalLight(0xffffff, 0.9)
    dir.position.set(2, 3, 4)
    scene.add(dir)

    const geom = new THREE.TorusKnotGeometry(1, 0.34, 240, 28)
    const mat = new THREE.MeshStandardMaterial({
      color: 0x7ef2df,
      metalness: 0.55,
      roughness: 0.2,
      emissive: new THREE.Color(0x1f3a37),
      emissiveIntensity: 0.25,
    })
    const mesh = new THREE.Mesh(geom, mat)
    scene.add(mesh)

    camera.position.set(0, 0.6, 3.2)
    camera.lookAt(0, 0, 0)

    const resize = () => {
      const w = mount.clientWidth || 560
      const h = height
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    window.addEventListener('resize', resize)

    let raf = 0
    const start = performance.now()
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const t = (performance.now() - start) / 1000
      mesh.rotation.x = t * 0.45
      mesh.rotation.y = t * 0.22
      const s = 0.92 + Math.sin(t * 1.4) * 0.06
      mesh.scale.setScalar(s)
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      renderer.dispose()
      geom.dispose()
      mat.dispose()
      if (renderer.domElement && renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [height])

  return <div ref={mountRef} style={{ width: '100%', height }} />
}

