import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';

function Plate({ geometry }) {
  const ref = useRef();
  useEffect(() => {
    if (ref.current && geometry) {
      ref.current.geometry = geometry;
    }
  }, [geometry]);
  if (!geometry) return null;
  return (
    <mesh ref={ref} castShadow receiveShadow>
      <meshStandardMaterial color="#d8c9b4" roughness={0.65} metalness={0.05} />
    </mesh>
  );
}

export default function PlateViewer({ geometry, placeholder }) {
  return (
    <div className="viewer">
      <Canvas
        shadows
        dpr={[1, 2]}
        onCreated={({ camera }) => {
          // Mesh uses Z-up (3D-printing convention).
          THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
          camera.up.set(0, 0, 1);
          camera.position.set(180, -220, 170);
          camera.lookAt(0, 0, 12);
        }}
        camera={{ fov: 35, near: 0.1, far: 2000 }}
      >
        <color attach="background" args={['#1b1d21']} />
        <ambientLight intensity={0.5} />
        <directionalLight
          position={[120, -90, 220]}
          intensity={1.2}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        <directionalLight position={[-120, 90, 90]} intensity={0.3} />
        <Grid
          args={[600, 600]}
          cellSize={10}
          sectionSize={50}
          sectionColor="#444"
          cellColor="#2a2c30"
          infiniteGrid
          fadeDistance={700}
          position={[0, 0, -0.01]}
          rotation={[-Math.PI / 2, 0, 0]}
        />
        <Plate geometry={geometry} />
        <OrbitControls makeDefault target={[0, 0, 12]} />
      </Canvas>
      {!geometry && <div className="placeholder">{placeholder}</div>}
    </div>
  );
}
