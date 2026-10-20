import * as THREE from 'three'
import type { CharacterModel } from '../../engine/rig/avatar'
import { ghostMaterial } from './shaders'

interface Ghost {
  group: THREE.Group
  skeleton: THREE.Skeleton
  mat: THREE.ShaderMaterial
  life: number
  maxLife: number
}

const ID = new THREE.Matrix4()

/**
 * Afterimages: frozen copies of the hero's pose. Each ghost owns a skeleton
 * whose bone matrices are snapshotted once and never updated, and reuses the
 * hero's geometry, so a ghost costs a handful of draw calls and no CPU.
 */
export class Afterimages {
  readonly root = new THREE.Group()
  private ghosts: Ghost[] = []
  private next = 0
  private source: CharacterModel | null = null

  bind(model: CharacterModel, count = 14) {
    this.source = model
    this.root.clear()
    this.ghosts = []
    for (let i = 0; i < count; i++) {
      const skeleton = new THREE.Skeleton(model.skeleton.bones, model.skeleton.boneInverses)
      skeleton.computeBoneTexture()
      skeleton.update = () => {}
      const mat = ghostMaterial()
      const group = new THREE.Group()
      for (const m of model.meshes) {
        const g = new THREE.SkinnedMesh(m.geometry, mat)
        g.bindMode = THREE.DetachedBindMode
        g.bind(skeleton, ID)
        g.frustumCulled = false
        g.renderOrder = 5
        group.add(g)
      }
      group.visible = false
      this.root.add(group)
      this.ghosts.push({ group, skeleton, mat, life: 0, maxLife: 1 })
    }
  }

  /** Freeze the hero's current pose as a fading ghost. */
  spawn(color: THREE.ColorRepresentation, life = 0.35, alpha = 1) {
    const src = this.source
    if (!src || !this.ghosts.length) return
    const g = this.ghosts[this.next]
    this.next = (this.next + 1) % this.ghosts.length
    src.skeleton.update()
    g.skeleton.boneMatrices!.set(src.skeleton.boneMatrices!.subarray(0, g.skeleton.boneMatrices!.length))
    g.skeleton.boneTexture!.needsUpdate = true
    g.mat.uniforms.uColor.value.set(color)
    g.mat.uniforms.uAlpha.value = alpha
    g.life = life
    g.maxLife = life
    g.group.visible = true
    g.group.userData.alpha = alpha
  }

  clear() {
    for (const g of this.ghosts) {
      g.life = 0
      g.group.visible = false
    }
  }

  update(dt: number) {
    for (const g of this.ghosts) {
      if (g.life <= 0) continue
      g.life -= dt
      if (g.life <= 0) {
        g.group.visible = false
        continue
      }
      const k = g.life / g.maxLife
      g.mat.uniforms.uAlpha.value = (g.group.userData.alpha as number) * k * k
    }
  }
}
