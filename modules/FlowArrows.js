/**
 * FlowArrows.js — Flow Direction Visualization
 * 
 * FLOW DIRECTION LOGIC:
 * Water flows from HIGHER invert elevation to LOWER invert elevation.
 * 
 * For each pipe:
 *   fromInvert = fromMH.cover_elev - pipe.from_depth
 *   toInvert   = toMH.cover_elev   - pipe.to_depth
 * 
 * If fromInvert > toInvert: flow goes from from_mh → to_mh
 * If toInvert   > fromInvert: flow goes from to_mh   → from_mh
 * 
 * The arrow mesh is placed at the pipe midpoint, pointing downstream.
 * Uses a single InstancedMesh for all arrows (1 draw call).
 * Auto-fades when camera is far away.
 */

import * as THREE from 'three';

export class FlowArrows {
  constructor(scene, pipeData, coordSystem) {
    this.scene = scene;
    this.pipeData = pipeData;
    this.coordSystem = coordSystem;
    this.mesh = null;
    this.visible = false;
    this._buildMesh();
  }

  _buildMesh() {
    // Arrow geometry: cone pointing along +Y, translated so base is at origin
    const coneGeo = new THREE.ConeGeometry(0.18, 0.45, 8);
    coneGeo.translate(0, 0.225, 0);

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x00aaff,
      emissiveIntensity: 2.0,
      roughness: 0.2,
      metalness: 0.6,
      transparent: true,
      opacity: 0.95
    });

    const validPipes = this.pipeData.filter(p => p && p.fromInvert !== undefined);
    const count = validPipes.length;
    if (count === 0) return;

    this.mesh = new THREE.InstancedMesh(coneGeo, material, count);
    this.mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(count * 16), 16);
    this.mesh.name = 'flow_arrows';
    this.mesh.visible = false;
    this.mesh.renderOrder = 10; // Draw on top of pipes

    const dummy = new THREE.Object3D();
    let instanceIdx = 0;

    validPipes.forEach(pd => {
      if (!pd) return;

      // Determine flow direction: from higher invert to lower invert
      const flowsFromP1 = pd.fromInvert >= pd.toInvert;
      const start = flowsFromP1 ? pd.p1 : pd.p2;
      const end = flowsFromP1 ? pd.p2 : pd.p1;

      const dir = new THREE.Vector3().subVectors(end, start).normalize();
      const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);

      // Position arrow at midpoint, slightly above pipe
      dummy.position.copy(mid).add(new THREE.Vector3(0, pd.rp * 2.5 + 0.4, 0));

      // Orient arrow along flow direction (cone points +Y by default)
      const up = new THREE.Vector3(0, 1, 0);
      if (Math.abs(dir.dot(up)) > 0.999) {
        dummy.quaternion.setFromUnitVectors(up, dir);
      } else {
        dummy.quaternion.setFromUnitVectors(up, dir);
      }

      // Scale based on pipe size (larger pipes = larger arrows)
      const scale = Math.min(2.0, Math.max(0.8, pd.rp * 10));
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(instanceIdx, dummy.matrix);

      instanceIdx++;
    });

    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.scene.add(this.mesh);
  }

  setVisible(visible) {
    this.visible = visible;
    if (this.mesh) this.mesh.visible = visible;
  }

  toggle() {
    this.setVisible(!this.visible);
    return this.visible;
  }

  update(camera) {
    if (!this.mesh || !this.visible) return;

    const dist = camera.position.distanceTo(new THREE.Vector3(0, 0, 0));
    // Fade opacity: full at <150m, fade to 0 at >400m
    const targetOpacity = dist > 400 ? 0 : (dist > 150 ? 0.95 * (1 - (dist - 150) / 250) : 0.95);

    if (Math.abs(this.mesh.material.opacity - targetOpacity) > 0.01) {
      this.mesh.material.opacity = targetOpacity;
      this.mesh.material.needsUpdate = true;
    }

    this.mesh.visible = targetOpacity > 0.05;
  }

  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
  }
}