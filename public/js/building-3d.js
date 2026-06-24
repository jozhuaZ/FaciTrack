/**
 * FaciTrack 3D Building Viewer
 * Using Three.js to display CCS Building with interactive rooms
 * Supports: Geometric placeholder OR Tripo3D.ai generated model (.glb/.gltf)
 */

class Building3DViewer {
    constructor(containerId, options = {}) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error(`Container #${containerId} not found`);
            return;
        }

        this.options = {
            modelPath: options.modelPath || null, // Path to .glb/.gltf model from Tripo3D
            useGeometricFallback: options.useGeometricFallback !== false,
            enableInteraction: options.enableInteraction !== false,
            roomData: options.roomData || [],
            onRoomClick: options.onRoomClick || null,
            ...options
        };

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.buildingModel = null;
        this.rooms = [];
        this.currentFloor = 0; // 0=all, 1-4=specific floor
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this.init();
    }

    init() {
        this.setupScene();
        this.setupCamera();
        this.setupRenderer();
        this.setupLights();
        this.setupControls();
        this.loadBuilding();
        this.setupEventListeners();
        this.animate();
    }

    setupScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xe8f2f7); // Light gray-blue sky matching reference
        this.scene.fog = new THREE.Fog(0xe8f2f7, 80, 250); // Atmospheric fog
    }

    setupCamera() {
        const aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 500);
        // Better initial angle matching reference image perspective
        this.camera.position.set(45, 18, 35);
        this.camera.lookAt(0, 6, 0);
    }

    setupRenderer() {
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);
    }

    setupLights() {
        // Enhanced realistic lighting matching reference image
        
        // Ambient light (soft overall illumination)
        const ambientLight = new THREE.AmbientLight(0xe8f0f5, 0.6);
        this.scene.add(ambientLight);

        // Main directional light (sun) - bright daylight
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
        directionalLight.position.set(50, 80, 40);
        directionalLight.castShadow = true;
        directionalLight.shadow.camera.left = -80;
        directionalLight.shadow.camera.right = 80;
        directionalLight.shadow.camera.top = 80;
        directionalLight.shadow.camera.bottom = -80;
        directionalLight.shadow.camera.near = 0.5;
        directionalLight.shadow.camera.far = 200;
        directionalLight.shadow.mapSize.width = 4096;
        directionalLight.shadow.mapSize.height = 4096;
        directionalLight.shadow.bias = -0.0005;
        this.scene.add(directionalLight);

        // Secondary fill light (sky light from opposite)
        const fillLight = new THREE.DirectionalLight(0xb3d9f2, 0.4);
        fillLight.position.set(-40, 60, -40);
        this.scene.add(fillLight);

        // Hemisphere light (realistic sky/ground)
        const hemiLight = new THREE.HemisphereLight(0xdeeef7, 0xa89f91, 0.7);
        this.scene.add(hemiLight);

        // Ground bounce light (simulates light reflecting from ground)
        const groundLight = new THREE.DirectionalLight(0xf5f5f5, 0.2);
        groundLight.position.set(0, -20, 0);
        this.scene.add(groundLight);
    }

    setupControls() {
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.minDistance = 15;
        this.controls.maxDistance = 80;
        this.controls.maxPolarAngle = Math.PI / 2.1; // Prevent going below ground
        this.controls.target.set(0, 8, 0);
    }

    async loadBuilding() {
        // Try to load model from Tripo3D (if path provided)
        if (this.options.modelPath) {
            try {
                await this.loadTripo3DModel(this.options.modelPath);
                console.log('[3D Viewer] Loaded Tripo3D model successfully');
                return;
            } catch (error) {
                console.warn('[3D Viewer] Failed to load model, using geometric fallback:', error);
            }
        }

        // Fallback: Create geometric building
        if (this.options.useGeometricFallback) {
            this.createGeometricBuilding();
        }
    }

    async loadTripo3DModel(modelPath) {
        return new Promise((resolve, reject) => {
            const loader = new THREE.GLTFLoader();
            
            loader.load(
                modelPath,
                (gltf) => {
                    this.buildingModel = gltf.scene;
                    
                    // Scale and position model
                    this.buildingModel.scale.set(1, 1, 1);
                    this.buildingModel.position.set(0, 0, 0);
                    
                    // Enable shadows
                    this.buildingModel.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });
                    
                    this.scene.add(this.buildingModel);
                    this.extractRoomsFromModel();
                    resolve();
                },
                (progress) => {
                    const percent = (progress.loaded / progress.total * 100).toFixed(0);
                    console.log(`Loading model: ${percent}%`);
                },
                (error) => {
                    reject(error);
                }
            );
        });
    }

    createGeometricBuilding() {
        const building = new THREE.Group();
        
        // Enhanced ground plane matching reference image
        const groundGeometry = new THREE.PlaneGeometry(150, 120);
        const groundMaterial = new THREE.MeshStandardMaterial({ 
            color: 0xd8d8d8, // Light gray concrete ground
            roughness: 0.92,
            metalness: 0.02
        });
        const ground = new THREE.Mesh(groundGeometry, groundMaterial);
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.scene.add(ground);

        // Grass areas on sides
        const grassGeometry = new THREE.PlaneGeometry(40, 120);
        const grassMaterial = new THREE.MeshStandardMaterial({
            color: 0x7a9970,
            roughness: 0.98,
            metalness: 0
        });
        
        const leftGrass = new THREE.Mesh(grassGeometry, grassMaterial);
        leftGrass.rotation.x = -Math.PI / 2;
        leftGrass.position.set(-55, 0.01, 0);
        leftGrass.receiveShadow = true;
        this.scene.add(leftGrass);
        
        const rightGrass = new THREE.Mesh(grassGeometry, grassMaterial);
        rightGrass.rotation.x = -Math.PI / 2;
        rightGrass.position.set(55, 0.01, 0);
        rightGrass.receiveShadow = true;
        this.scene.add(rightGrass);

        // Building dimensions matching reference image exactly
        const floors = 4;
        const floorHeight = 3.2; // Realistic floor height
        const buildingWidth = 60;  // Long horizontal structure
        const buildingDepth = 14;  // Deeper to show interior spaces

        // Create each floor with extreme detail
        for (let floor = 0; floor < floors; floor++) {
            const floorGroup = this.createDetailedFloor(floor, buildingWidth, buildingDepth, floorHeight);
            building.add(floorGroup);
        }

        // Roof structure matching reference
        this.createDetailedRoof(building, buildingWidth, buildingDepth, floors * floorHeight);

        // Add realistic environment elements
        this.addEnvironmentElements(building, buildingWidth, buildingDepth);

        this.scene.add(building);
        this.buildingModel = building;
    }

    createDetailedFloor(floorNumber, width, depth, height) {
        const floorGroup = new THREE.Group();
        floorGroup.userData.floor = floorNumber + 1;
        
        const yPos = floorNumber * height + height / 2;

        // GROUND FLOOR: Pilotis with diagonal cross-bracing (EXACTLY like reference)
        if (floorNumber === 0) {
            this.createRealisticGroundFloor(floorGroup, width, depth, height, yPos);
        } else {
            // UPPER FLOORS: Open corridors with deep recesses
            this.createRealisticUpperFloor(floorGroup, floorNumber, width, depth, height, yPos);
        }

        return floorGroup;
    }

    createRealisticGroundFloor(floorGroup, width, depth, height, yPos) {
        // Floor slab (top of ground floor)
        const floorGeometry = new THREE.BoxGeometry(width, 0.35, depth);
        const floorMaterial = new THREE.MeshStandardMaterial({ 
            color: 0xb8c5d1,
            roughness: 0.88,
            metalness: 0.05
        });
        const floorSlab = new THREE.Mesh(floorGeometry, floorMaterial);
        floorSlab.position.y = yPos + height / 2;
        floorSlab.castShadow = true;
        floorSlab.receiveShadow = true;
        floorGroup.add(floorSlab);

        // Main structural pillars (large square columns) - DARKER blue
        const pillarGeometry = new THREE.BoxGeometry(1.2, height, 1.2);
        const pillarMaterial = new THREE.MeshStandardMaterial({
            color: 0x5a8fa8,
            roughness: 0.7,
            metalness: 0.08
        });

        // LEFT SECTION - with diagonal bracing (matching reference!)
        const leftSectionWidth = 12;
        const numPillarsLeft = 3;
        const leftSpacing = leftSectionWidth / (numPillarsLeft - 1);

        for (let z = 0; z < 3; z++) {
            for (let x = 0; x < numPillarsLeft; x++) {
                const pillar = new THREE.Mesh(pillarGeometry, pillarMaterial);
                pillar.position.set(
                    -width / 2 + 2 + x * leftSpacing,
                    yPos,
                    -depth / 2 + 2 + z * 4
                );
                pillar.castShadow = true;
                pillar.receiveShadow = true;
                floorGroup.add(pillar);

                // Add diagonal bracing between pillars (ONLY in end sections!)
                if (x < numPillarsLeft - 1) {
                    this.addDiagonalBracing(floorGroup, pillar.position, leftSpacing, 4, height, yPos);
                }
            }
        }

        // RIGHT SECTION - with diagonal bracing (matching reference!)
        const rightSectionWidth = 12;
        const numPillarsRight = 3;
        const rightSpacing = rightSectionWidth / (numPillarsRight - 1);

        for (let z = 0; z < 3; z++) {
            for (let x = 0; x < numPillarsRight; x++) {
                const pillar = new THREE.Mesh(pillarGeometry, pillarMaterial);
                pillar.position.set(
                    width / 2 - 2 - x * rightSpacing,
                    yPos,
                    -depth / 2 + 2 + z * 4
                );
                pillar.castShadow = true;
                pillar.receiveShadow = true;
                floorGroup.add(pillar);

                // Add diagonal bracing between pillars (ONLY in end sections!)
                if (x < numPillarsRight - 1) {
                    this.addDiagonalBracing(floorGroup, pillar.position, rightSpacing, 4, height, yPos);
                }
            }
        }

        // CENTER SECTION - Large vertical openings (NO diagonal bracing here!)
        // This creates the big entrance/door areas visible in reference

        // Front center pillars (creating openings)
        const numCenterPillars = 8;
        const centerWidth = width - 2 * leftSectionWidth;
        const centerSpacing = centerWidth / (numCenterPillars - 1);

        for (let i = 0; i < numCenterPillars; i++) {
            const pillar = new THREE.Mesh(pillarGeometry, pillarMaterial);
            pillar.position.set(
                -centerWidth / 2 + i * centerSpacing,
                yPos,
                depth / 2 - 2
            );
            pillar.castShadow = true;
            pillar.receiveShadow = true;
            floorGroup.add(pillar);

            // Back pillars
            const backPillar = new THREE.Mesh(pillarGeometry, pillarMaterial);
            backPillar.position.set(
                -centerWidth / 2 + i * centerSpacing,
                yPos,
                -depth / 2 + 2
            );
            backPillar.castShadow = true;
            backPillar.receiveShadow = true;
            floorGroup.add(backPillar);
        }

        // "ACADEMIC BUILDING IV" signage (reference shows this on ground floor)
        const signageGeometry = new THREE.PlaneGeometry(20, 1.5);
        const signageMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.6
        });
        const signage = new THREE.Mesh(signageGeometry, signageMaterial);
        signage.position.set(0, yPos + height / 2 - 0.8, depth / 2 + 0.02);
        floorGroup.add(signage);

        // Blue frame around signage
        const frameGeometry = new THREE.BoxGeometry(20.3, 1.7, 0.08);
        const frameMaterial = new THREE.MeshStandardMaterial({
            color: 0x2d4a5c,
            roughness: 0.65
        });
        const frame = new THREE.Mesh(frameGeometry, frameMaterial);
        frame.position.set(0, yPos + height / 2 - 0.8, depth / 2 - 0.02);
        frame.castShadow = true;
        floorGroup.add(frame);

        // Back wall for ground floor
        const backWallGeometry = new THREE.BoxGeometry(width, height, 0.25);
        const wallMaterial = new THREE.MeshStandardMaterial({
            color: 0x7fadbe,
            roughness: 0.75,
            metalness: 0.06
        });
        const backWall = new THREE.Mesh(backWallGeometry, wallMaterial);
        backWall.position.set(0, yPos, -depth / 2 + 0.125);
        backWall.castShadow = true;
        backWall.receiveShadow = true;
        floorGroup.add(backWall);
    }

    addDiagonalBracing(floorGroup, pillarPos, spacingX, spacingZ, height, yPos) {
        // X-shaped diagonal bracing between pillars (CRITICAL for matching reference!)
        const braceLength = Math.sqrt(spacingX * spacingX + height * height);
        const braceGeometry = new THREE.BoxGeometry(0.25, 0.25, braceLength); // THICKER for visibility
        const braceMaterial = new THREE.MeshStandardMaterial({
            color: 0x3d5a6b, // Very dark blue for bracing (stands out!)
            roughness: 0.65,
            metalness: 0.15
        });

        const nextPillarX = pillarPos.x + spacingX;
        const centerX = pillarPos.x + spacingX / 2;
        const bottomY = yPos - height / 2;
        const topY = yPos + height / 2;

        // Diagonal brace 1 (bottom-left to top-right: /)
        const brace1 = new THREE.Mesh(braceGeometry, braceMaterial);
        brace1.position.set(centerX, yPos, pillarPos.z);
        brace1.rotation.y = Math.PI / 2;
        brace1.rotation.z = Math.atan(height / spacingX);
        brace1.castShadow = true;
        floorGroup.add(brace1);

        // Diagonal brace 2 (top-left to bottom-right: \)
        const brace2 = new THREE.Mesh(braceGeometry, braceMaterial);
        brace2.position.set(centerX, yPos, pillarPos.z);
        brace2.rotation.y = Math.PI / 2;
        brace2.rotation.z = -Math.atan(height / spacingX);
        brace2.castShadow = true;
        floorGroup.add(brace2);
    }

    createRealisticUpperFloor(floorGroup, floorNumber, width, depth, height, yPos) {
        // Floor slab (bottom of this floor)
        const floorGeometry = new THREE.BoxGeometry(width, 0.3, depth);
        const floorMaterial = new THREE.MeshStandardMaterial({ 
            color: 0xb8c5d1,
            roughness: 0.88,
            metalness: 0.05
        });
        const floorSlab = new THREE.Mesh(floorGeometry, floorMaterial);
        floorSlab.position.y = yPos - height / 2;
        floorSlab.castShadow = true;
        floorSlab.receiveShadow = true;
        floorGroup.add(floorSlab);

        // Ceiling slab (top of this floor)
        const ceilingSlab = new THREE.Mesh(floorGeometry, floorMaterial);
        ceilingSlab.position.y = yPos + height / 2;
        ceilingSlab.castShadow = true;
        ceilingSlab.receiveShadow = true;
        floorGroup.add(ceilingSlab);

        // Back wall (solid, lighter blue)
        const backWallGeometry = new THREE.BoxGeometry(width, height - 0.6, 0.25);
        const wallMaterial = new THREE.MeshStandardMaterial({
            color: 0x93c7d9, // Lighter blue for upper walls
            roughness: 0.78,
            metalness: 0.05
        });
        const backWall = new THREE.Mesh(backWallGeometry, wallMaterial);
        backWall.position.set(0, yPos, -depth / 2 + 0.125);
        backWall.castShadow = true;
        backWall.receiveShadow = true;
        floorGroup.add(backWall);

        // Corridor depth - create recessed open space (CRITICAL for matching reference!)
        const corridorDepth = 3.5; // Deep corridor matching reference
        const roomDepth = depth - corridorDepth;

        // Room interior walls (darker, showing depth)
        const interiorWallGeometry = new THREE.BoxGeometry(width - 1, height - 0.6, 0.2);
        const interiorMaterial = new THREE.MeshStandardMaterial({
            color: 0x4a6578, // Dark blue-gray for interior walls (shows depth!)
            roughness: 0.85,
            metalness: 0.03
        });
        const interiorWall = new THREE.Mesh(interiorWallGeometry, interiorMaterial);
        interiorWall.position.set(0, yPos, -depth / 2 + roomDepth);
        interiorWall.receiveShadow = true;
        floorGroup.add(interiorWall);

        // Structural columns (darker blue, thicker)
        const numColumns = 11;
        const columnSpacing = (width - 4) / (numColumns - 1);
        const columnGeometry = new THREE.BoxGeometry(0.65, height - 0.6, 0.65);
        const columnMaterial = new THREE.MeshStandardMaterial({
            color: 0x5a8fa8, // Darker blue for structural columns
            roughness: 0.72,
            metalness: 0.08
        });

        for (let i = 0; i < numColumns; i++) {
            // Outer corridor columns (front edge)
            const outerColumn = new THREE.Mesh(columnGeometry, columnMaterial);
            outerColumn.position.set(
                -width / 2 + 2 + i * columnSpacing,
                yPos,
                depth / 2 - corridorDepth + 0.3
            );
            outerColumn.castShadow = true;
            outerColumn.receiveShadow = true;
            floorGroup.add(outerColumn);

            // Inner corridor columns (back edge of corridor)
            const innerColumn = new THREE.Mesh(columnGeometry, columnMaterial);
            innerColumn.position.set(
                -width / 2 + 2 + i * columnSpacing,
                yPos,
                -depth / 2 + roomDepth - 0.3
            );
            innerColumn.castShadow = true;
            innerColumn.receiveShadow = true;
            floorGroup.add(innerColumn);
        }

        // Horizontal railings/beams (lighter blue trim)
        const beamGeometry = new THREE.BoxGeometry(width - 2, 0.3, 0.3);
        const beamMaterial = new THREE.MeshStandardMaterial({
            color: 0xa8d4e5, // Light blue for beams/trim
            roughness: 0.65,
            metalness: 0.12
        });

        // Top beam
        const topBeam = new THREE.Mesh(beamGeometry, beamMaterial);
        topBeam.position.set(0, yPos + height / 2 - 0.45, depth / 2 - corridorDepth + 0.3);
        topBeam.castShadow = true;
        floorGroup.add(topBeam);

        // Bottom beam (floor edge)
        const bottomBeam = new THREE.Mesh(beamGeometry, beamMaterial);
        bottomBeam.position.set(0, yPos - height / 2 + 0.15, depth / 2 - corridorDepth + 0.3);
        bottomBeam.castShadow = true;
        floorGroup.add(bottomBeam);

        // Railing (horizontal bars)
        for (let i = 0; i < 3; i++) {
            const railGeometry = new THREE.BoxGeometry(width - 3, 0.08, 0.08);
            const railMaterial = new THREE.MeshStandardMaterial({
                color: 0xb0d8ea,
                roughness: 0.55,
                metalness: 0.18
            });
            const rail = new THREE.Mesh(railGeometry, railMaterial);
            rail.position.set(
                0,
                yPos - height / 2 + 0.6 + i * 0.3,
                depth / 2 - corridorDepth + 0.3
            );
            rail.castShadow = true;
            floorGroup.add(rail);
        }

        // Windows and interior details
        this.addWindowsAndDetails(floorGroup, floorNumber, width, depth, height, yPos, roomDepth);

        // Side walls (end caps)
        const sideWallGeometry = new THREE.BoxGeometry(0.3, height - 0.6, depth);
        const leftWall = new THREE.Mesh(sideWallGeometry, wallMaterial);
        leftWall.position.set(-width / 2 + 0.15, yPos, 0);
        leftWall.castShadow = true;
        leftWall.receiveShadow = true;
        floorGroup.add(leftWall);

        const rightWall = new THREE.Mesh(sideWallGeometry, wallMaterial);
        rightWall.position.set(width / 2 - 0.15, yPos, 0);
        rightWall.castShadow = true;
        rightWall.receiveShadow = true;
        floorGroup.add(rightWall);

        // Rooms (interactive)
        this.createRoomsForFloor(floorGroup, floorNumber, width, depth, height, yPos);
    }

    addWindowsAndDetails(floorGroup, floorNumber, width, depth, height, yPos, roomDepth) {
        // Windows on back wall (matching reference - grid pattern)
        const numWindows = 10;
        const windowSpacing = (width - 8) / numWindows;

        for (let i = 0; i < numWindows; i++) {
            // Glass window (VERY DARK like reference - shows interior darkness)
            const windowGeometry = new THREE.PlaneGeometry(4.2, 1.8);
            const windowMaterial = new THREE.MeshPhysicalMaterial({
                color: 0x1a2530, // VERY dark blue-black (like reference!)
                transparent: true,
                opacity: 0.7,
                roughness: 0.12,
                metalness: 0.05,
                transmission: 0.3,
                thickness: 0.5
            });
            const window = new THREE.Mesh(windowGeometry, windowMaterial);
            window.position.set(
                -width / 2 + 4 + i * windowSpacing,
                yPos + 0.2,
                -depth / 2 + 0.135
            );
            floorGroup.add(window);

            // Window frame (light blue trim - visible in reference)
            const frameGeometry = new THREE.BoxGeometry(4.4, 2.0, 0.08);
            const frameMaterial = new THREE.MeshStandardMaterial({
                color: 0xa0c8d8, // Light blue window frame
                roughness: 0.6,
                metalness: 0.25
            });
            const frame = new THREE.Mesh(frameGeometry, frameMaterial);
            frame.position.set(
                -width / 2 + 4 + i * windowSpacing,
                yPos + 0.2,
                -depth / 2 + 0.08
            );
            floorGroup.add(frame);

            // Window divider (horizontal bar in middle)
            const dividerGeometry = new THREE.BoxGeometry(4.3, 0.08, 0.08);
            const dividerMaterial = new THREE.MeshStandardMaterial({
                color: 0x7fa8b8,
                roughness: 0.65,
                metalness: 0.3
            });
            const divider = new THREE.Mesh(dividerGeometry, dividerMaterial);
            divider.position.set(
                -width / 2 + 4 + i * windowSpacing,
                yPos + 0.2,
                -depth / 2 + 0.12
            );
            floorGroup.add(divider);
        }

        // Interior ceiling (visible through corridor - VERY DARK for depth)
        const interiorCeilingGeometry = new THREE.BoxGeometry(width - 2, 0.2, roomDepth - 0.5);
        const interiorCeilingMaterial = new THREE.MeshStandardMaterial({
            color: 0x2a3642, // Very dark blue-gray
            roughness: 0.92
        });
        const interiorCeiling = new THREE.Mesh(interiorCeilingGeometry, interiorCeilingMaterial);
        interiorCeiling.position.set(0, yPos + height / 2 - 0.1, -depth / 2 + roomDepth / 2);
        interiorCeiling.receiveShadow = true;
        floorGroup.add(interiorCeiling);
    }

    createRealisticWindows(floorGroup, floorNumber, width, depth, height, yPos) {
        const numWindows = 14; // 14 window sections per floor
        const windowSpacing = (width - 8) / numWindows;

        for (let i = 0; i < numWindows; i++) {
            // Reflective glass window with realistic transparency
            const windowGeometry = new THREE.PlaneGeometry(3.8, 2.2);
            const windowMaterial = new THREE.MeshPhysicalMaterial({
                color: 0xb8d4e6, // Light blue tinted glass
                transparent: true,
                opacity: 0.35,
                metalness: 0.05,
                roughness: 0.05,
                transmission: 0.92,
                thickness: 0.6,
                envMapIntensity: 1.5
            });
            const window = new THREE.Mesh(windowGeometry, windowMaterial);
            window.position.set(
                -width / 2 + 4 + i * windowSpacing,
                yPos + 0.1,
                -depth / 2 + 0.135
            );
            floorGroup.add(window);

            // Aluminum window frame
            const frameGeometry = new THREE.BoxGeometry(4.0, 2.4, 0.08);
            const frameMaterial = new THREE.MeshStandardMaterial({
                color: 0xdce3ea, // Light gray aluminum
                roughness: 0.55,
                metalness: 0.35
            });
            const frame = new THREE.Mesh(frameGeometry, frameMaterial);
            frame.position.set(
                -width / 2 + 4 + i * windowSpacing,
                yPos + 0.1,
                -depth / 2 + 0.08
            );
            floorGroup.add(frame);

            // Window divider (cross pattern)
            const dividerGeometry = new THREE.BoxGeometry(4.0, 0.05, 0.05);
            const dividerMaterial = new THREE.MeshStandardMaterial({
                color: 0xc5cdd5,
                roughness: 0.6,
                metalness: 0.3
            });
            const horizontalDivider = new THREE.Mesh(dividerGeometry, dividerMaterial);
            horizontalDivider.position.set(
                -width / 2 + 4 + i * windowSpacing,
                yPos + 0.1,
                -depth / 2 + 0.15
            );
            floorGroup.add(horizontalDivider);

            const verticalDividerGeometry = new THREE.BoxGeometry(0.05, 2.4, 0.05);
            const verticalDivider = new THREE.Mesh(verticalDividerGeometry, dividerMaterial);
            verticalDivider.position.set(
                -width / 2 + 4 + i * windowSpacing,
                yPos + 0.1,
                -depth / 2 + 0.15
            );
            floorGroup.add(verticalDivider);
        }
    }

    createDetailedRoof(building, width, depth, topY) {
        // Main roof slab
        const roofGeometry = new THREE.BoxGeometry(width + 0.4, 0.4, depth + 0.4);
        const roofMaterial = new THREE.MeshStandardMaterial({ 
            color: 0x93c7d9, // Light blue matching upper walls
            roughness: 0.82,
            metalness: 0.06
        });
        const roof = new THREE.Mesh(roofGeometry, roofMaterial);
        roof.position.y = topY + 0.2;
        roof.castShadow = true;
        roof.receiveShadow = true;
        building.add(roof);

        // Parapet walls (all 4 sides)
        const parapetHeight = 1.0;
        const parapetMaterial = new THREE.MeshStandardMaterial({
            color: 0x7fadbe,
            roughness: 0.78,
            metalness: 0.05
        });
        
        // Front parapet
        const frontParapetGeometry = new THREE.BoxGeometry(width + 0.6, parapetHeight, 0.2);
        const frontParapet = new THREE.Mesh(frontParapetGeometry, parapetMaterial);
        frontParapet.position.set(0, topY + 0.4 + parapetHeight / 2, depth / 2 + 0.3);
        frontParapet.castShadow = true;
        building.add(frontParapet);
        
        // Back parapet
        const backParapet = new THREE.Mesh(frontParapetGeometry, parapetMaterial);
        backParapet.position.set(0, topY + 0.4 + parapetHeight / 2, -depth / 2 - 0.3);
        backParapet.castShadow = true;
        building.add(backParapet);

        // Left parapet
        const sideParapetGeometry = new THREE.BoxGeometry(0.2, parapetHeight, depth + 0.8);
        const leftParapet = new THREE.Mesh(sideParapetGeometry, parapetMaterial);
        leftParapet.position.set(-width / 2 - 0.4, topY + 0.4 + parapetHeight / 2, 0);
        leftParapet.castShadow = true;
        building.add(leftParapet);

        // Right parapet
        const rightParapet = new THREE.Mesh(sideParapetGeometry, parapetMaterial);
        rightParapet.position.set(width / 2 + 0.4, topY + 0.4 + parapetHeight / 2, 0);
        rightParapet.castShadow = true;
        building.add(rightParapet);

        // Ladder/access on side (visible in reference)
        this.addRoofLadder(building, width, depth, topY);
    }

    addRoofLadder(building, width, depth, topY) {
        // Vertical ladder on right side (matching reference image)
        const ladderMaterial = new THREE.MeshStandardMaterial({
            color: 0xb89860, // Weathered metal
            roughness: 0.85,
            metalness: 0.6
        });

        // Ladder rails
        const railGeometry = new THREE.BoxGeometry(0.05, topY + 1, 0.05);
        const leftRail = new THREE.Mesh(railGeometry, ladderMaterial);
        leftRail.position.set(width / 2 + 0.6, topY / 2, -depth / 2 + 1);
        leftRail.castShadow = true;
        building.add(leftRail);

        const rightRail = new THREE.Mesh(railGeometry, ladderMaterial);
        rightRail.position.set(width / 2 + 0.9, topY / 2, -depth / 2 + 1);
        rightRail.castShadow = true;
        building.add(rightRail);

        // Ladder rungs
        const rungGeometry = new THREE.BoxGeometry(0.4, 0.05, 0.05);
        for (let i = 0; i < Math.floor(topY / 0.4); i++) {
            const rung = new THREE.Mesh(rungGeometry, ladderMaterial);
            rung.position.set(width / 2 + 0.75, i * 0.4 + 0.5, -depth / 2 + 1);
            building.add(rung);
        }
    }

    addEnvironmentElements(building, width, depth) {
        // Planters/bollards in front (visible in reference)
        this.addPlanters(building, width, depth);
        
        // Trees on sides (visible in reference)
        this.addTrees(building, width, depth);
        
        // Parking area markings
        this.addParkingMarkings(width, depth);
    }

    addPlanters(building, width, depth) {
        const planterGeometry = new THREE.CylinderGeometry(0.6, 0.6, 0.8, 8);
        const planterMaterial = new THREE.MeshStandardMaterial({
            color: 0x3a3a3a, // Dark gray/black planters
            roughness: 0.8
        });

        // Place planters in front
        const planterPositions = [
            [-15, 0.4, depth / 2 + 8],
            [-5, 0.4, depth / 2 + 8],
            [5, 0.4, depth / 2 + 8],
            [15, 0.4, depth / 2 + 8]
        ];

        planterPositions.forEach(pos => {
            const planter = new THREE.Mesh(planterGeometry, planterMaterial);
            planter.position.set(pos[0], pos[1], pos[2]);
            planter.castShadow = true;
            planter.receiveShadow = true;
            building.add(planter);

            // Small tree/plant inside planter
            const plantGeometry = new THREE.ConeGeometry(0.4, 1.2, 8);
            const plantMaterial = new THREE.MeshStandardMaterial({
                color: 0x4a7c4e,
                roughness: 0.95
            });
            const plant = new THREE.Mesh(plantGeometry, plantMaterial);
            plant.position.set(pos[0], pos[1] + 1.0, pos[2]);
            plant.castShadow = true;
            building.add(plant);
        });
    }

    addTrees(building, width, depth) {
        const trunkGeometry = new THREE.CylinderGeometry(0.3, 0.4, 3, 8);
        const trunkMaterial = new THREE.MeshStandardMaterial({
            color: 0x6b4423,
            roughness: 0.95
        });

        const foliageGeometry = new THREE.SphereGeometry(2, 8, 8);
        const foliageMaterial = new THREE.MeshStandardMaterial({
            color: 0x5a8a5a,
            roughness: 0.9
        });

        // Tree positions on sides (matching reference)
        const treePositions = [
            [-45, 1.5, 10],
            [-45, 1.5, -10],
            [45, 1.5, 10],
            [45, 1.5, 0],
            [45, 1.5, -10]
        ];

        treePositions.forEach(pos => {
            // Tree trunk
            const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
            trunk.position.set(pos[0], pos[1], pos[2]);
            trunk.castShadow = true;
            this.scene.add(trunk);

            // Tree foliage
            const foliage = new THREE.Mesh(foliageGeometry, foliageMaterial);
            foliage.position.set(pos[0], pos[1] + 3, pos[2]);
            foliage.castShadow = true;
            foliage.receiveShadow = true;
            this.scene.add(foliage);
        });
    }

    addParkingMarkings(width, depth) {
        // Parking bay lines (white lines on ground)
        const lineGeometry = new THREE.PlaneGeometry(0.15, 5);
        const lineMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.9
        });

        for (let i = -3; i <= 3; i++) {
            const line = new THREE.Mesh(lineGeometry, lineMaterial);
            line.rotation.x = -Math.PI / 2;
            line.position.set(i * 8, 0.03, depth / 2 + 12);
            this.scene.add(line);
        }
    }

    addPhotorealisticSolarPanels(building, width, depth, yPos) {
        const panelGroup = new THREE.Group();
        
        // Solar panel specs EXACTLY matching aerial photo
        const panelWidth = 1.65;  // Standard solar panel width
        const panelHeight = 1.0;  // Standard solar panel height
        const panelThickness = 0.04;
        
        const panelGeometry = new THREE.BoxGeometry(panelWidth, panelThickness, panelHeight);
        const panelMaterial = new THREE.MeshStandardMaterial({
            color: 0x1a2842, // Dark blue-black solar cells
            roughness: 0.18,
            metalness: 0.75,
            envMapIntensity: 1.2
        });

        // Dense grid matching aerial photo: 8 rows × 22 columns
        const rows = 8;
        const cols = 22;
        const spacingX = 3.05;  // Horizontal spacing between panels
        const spacingZ = 1.45;  // Vertical spacing between panels
        const tiltAngle = -0.12; // 7-degree tilt towards sun

        // Calculate starting position to center the array
        const totalWidth = (cols - 1) * spacingX + panelWidth;
        const totalDepth = (rows - 1) * spacingZ + panelHeight;
        const startX = -totalWidth / 2;
        const startZ = -totalDepth / 2;

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const panel = new THREE.Mesh(panelGeometry, panelMaterial);
                panel.position.set(
                    startX + col * spacingX + panelWidth / 2,
                    yPos + 0.15,
                    startZ + row * spacingZ + panelHeight / 2
                );
                panel.rotation.x = tiltAngle;
                panel.castShadow = true;
                panel.receiveShadow = true;
                panelGroup.add(panel);

                // Aluminum panel frame
                const frameThickness = 0.05;
                const frameMaterial = new THREE.MeshStandardMaterial({
                    color: 0xa8b4c0, // Silver aluminum frame
                    roughness: 0.45,
                    metalness: 0.7
                });

                // Top frame edge
                const topFrameGeometry = new THREE.BoxGeometry(panelWidth + 0.05, frameThickness, 0.03);
                const topFrame = new THREE.Mesh(topFrameGeometry, frameMaterial);
                topFrame.position.copy(panel.position);
                topFrame.position.z -= panelHeight / 2;
                topFrame.rotation.x = tiltAngle;
                panelGroup.add(topFrame);

                // Bottom frame edge
                const bottomFrame = new THREE.Mesh(topFrameGeometry, frameMaterial);
                bottomFrame.position.copy(panel.position);
                bottomFrame.position.z += panelHeight / 2;
                bottomFrame.rotation.x = tiltAngle;
                panelGroup.add(bottomFrame);
            }
        }

        // Panel mounting rails (support structure)
        const railGeometry = new THREE.BoxGeometry(totalWidth, 0.08, 0.08);
        const railMaterial = new THREE.MeshStandardMaterial({
            color: 0x888e95, // Gray steel rails
            roughness: 0.65,
            metalness: 0.5
        });

        for (let row = 0; row < rows; row++) {
            const rail = new THREE.Mesh(railGeometry, railMaterial);
            rail.position.set(
                0,
                yPos + 0.08,
                startZ + row * spacingZ + panelHeight / 2
            );
            panelGroup.add(rail);
        }

        building.add(panelGroup);
    }

    addBuildingSignage(building, width, depth) {
        // "ACADEMIC BUILDING IV" text panel on ground floor front
        const signageGeometry = new THREE.PlaneGeometry(18, 1.8);
        const signageMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff, // White background
            roughness: 0.6,
            metalness: 0.1
        });
        const signage = new THREE.Mesh(signageGeometry, signageMaterial);
        signage.position.set(0, 2.2, depth / 2 + 0.02);
        signage.castShadow = true;
        building.add(signage);

        // Blue border frame around signage
        const frameGeometry = new THREE.BoxGeometry(18.5, 2.1, 0.1);
        const frameMaterial = new THREE.MeshStandardMaterial({
            color: 0x0a3d62, // Dark blue frame
            roughness: 0.5,
            metalness: 0.2
        });
        const frame = new THREE.Mesh(frameGeometry, frameMaterial);
        frame.position.set(0, 2.2, depth / 2 - 0.02);
        building.add(frame);
    }

    createSideStaircases(building, width, depth, totalHeight) {
        // Left side staircase (matching side view photos)
        this.createSingleStaircase(building, -width / 2 - 1.2, depth, totalHeight, 'left');
        
        // Right side staircase
        this.createSingleStaircase(building, width / 2 + 1.2, depth, totalHeight, 'right');
    }

    createSingleStaircase(building, xPos, depth, totalHeight, side) {
        const staircaseGroup = new THREE.Group();
        
        // Staircase enclosure structure
        const enclosureGeometry = new THREE.BoxGeometry(2.5, totalHeight, 4);
        const enclosureMaterial = new THREE.MeshStandardMaterial({
            color: 0x7DC5D9, // Light blue matching building
            roughness: 0.78,
            metalness: 0.05
        });
        const enclosure = new THREE.Mesh(enclosureGeometry, enclosureMaterial);
        enclosure.position.set(xPos, totalHeight / 2, -depth / 2 + 2);
        enclosure.castShadow = true;
        staircaseGroup.add(enclosure);

        // Staircase windows (small ventilation openings)
        const numFloors = 4;
        for (let floor = 0; floor < numFloors; floor++) {
            const windowGeometry = new THREE.PlaneGeometry(0.8, 1.2);
            const windowMaterial = new THREE.MeshPhysicalMaterial({
                color: 0xadd8e6,
                transparent: true,
                opacity: 0.4,
                roughness: 0.1
            });
            const window = new THREE.Mesh(windowGeometry, windowMaterial);
            const yPos = floor * 3.5 + 2;
            const zOffset = side === 'left' ? 0.1 : -0.1;
            window.position.set(xPos + zOffset, yPos, -depth / 2 + 2);
            window.rotation.y = side === 'left' ? Math.PI / 2 : -Math.PI / 2;
            staircaseGroup.add(window);
        }

        // External fire escape ladder (matching back view photo)
        const ladderGeometry = new THREE.BoxGeometry(0.05, totalHeight, 0.05);
        const ladderMaterial = new THREE.MeshStandardMaterial({
            color: 0xb8860b, // Dark goldenrod (rusted metal)
            roughness: 0.85,
            metalness: 0.6
        });
        
        const leftRail = new THREE.Mesh(ladderGeometry, ladderMaterial);
        leftRail.position.set(xPos - 0.3, totalHeight / 2, -depth / 2 + 0.5);
        staircaseGroup.add(leftRail);

        const rightRail = new THREE.Mesh(ladderGeometry, ladderMaterial);
        rightRail.position.set(xPos + 0.3, totalHeight / 2, -depth / 2 + 0.5);
        staircaseGroup.add(rightRail);

        // Ladder rungs
        const rungGeometry = new THREE.BoxGeometry(0.65, 0.05, 0.05);
        for (let i = 0; i < Math.floor(totalHeight / 0.4); i++) {
            const rung = new THREE.Mesh(rungGeometry, ladderMaterial);
            rung.position.set(xPos, i * 0.4, -depth / 2 + 0.5);
            staircaseGroup.add(rung);
        }

        building.add(staircaseGroup);
    }

    createCentralEntrance(building, width, depth, floorHeight) {
        // Central entrance canopy/projection (ground floor)
        const entranceWidth = 12;
        const entranceDepth = 2;
        const entranceHeight = floorHeight - 0.5;

        const entranceGeometry = new THREE.BoxGeometry(entranceWidth, entranceHeight, entranceDepth);
        const entranceMaterial = new THREE.MeshStandardMaterial({
            color: 0x7DC5D9,
            roughness: 0.75,
            metalness: 0.05
        });
        const entrance = new THREE.Mesh(entranceGeometry, entranceMaterial);
        entrance.position.set(0, entranceHeight / 2, depth / 2 + entranceDepth / 2);
        entrance.castShadow = true;
        building.add(entrance);

        // Entrance roof/canopy
        const canopyGeometry = new THREE.BoxGeometry(entranceWidth + 0.5, 0.3, entranceDepth + 0.5);
        const canopyMaterial = new THREE.MeshStandardMaterial({
            color: 0x6db5cc, // Slightly darker blue for canopy
            roughness: 0.7
        });
        const canopy = new THREE.Mesh(canopyGeometry, canopyMaterial);
        canopy.position.set(0, entranceHeight + 0.15, depth / 2 + entranceDepth / 2);
        canopy.castShadow = true;
        building.add(canopy);

        // Glass entrance doors
        const doorGeometry = new THREE.PlaneGeometry(3.5, entranceHeight - 0.5);
        const doorMaterial = new THREE.MeshPhysicalMaterial({
            color: 0x88c4de,
            transparent: true,
            opacity: 0.3,
            roughness: 0.05,
            metalness: 0.1,
            transmission: 0.95
        });
        
        // Left door
        const leftDoor = new THREE.Mesh(doorGeometry, doorMaterial);
        leftDoor.position.set(-2, entranceHeight / 2, depth / 2 + 0.05);
        building.add(leftDoor);

        // Right door
        const rightDoor = new THREE.Mesh(doorGeometry, doorMaterial);
        rightDoor.position.set(2, entranceHeight / 2, depth / 2 + 0.05);
        building.add(rightDoor);
    }

    addBackWallUtilities(building, width, depth, floors, floorHeight) {
        // Air conditioning units on back wall (matching back view photo)
        const acUnitGeometry = new THREE.BoxGeometry(1.2, 0.8, 0.35);
        const acUnitMaterial = new THREE.MeshStandardMaterial({
            color: 0xe5e7eb, // Light gray AC units
            roughness: 0.7,
            metalness: 0.25
        });

        // Place AC units on upper floors (3-4 per floor)
        for (let floor = 1; floor < floors; floor++) {
            const yPos = floor * floorHeight + floorHeight / 2;
            const numUnits = 4;
            const unitSpacing = width / (numUnits + 1);

            for (let i = 0; i < numUnits; i++) {
                const acUnit = new THREE.Mesh(acUnitGeometry, acUnitMaterial);
                acUnit.position.set(
                    -width / 2 + unitSpacing * (i + 1),
                    yPos,
                    -depth / 2 - 0.175
                );
                acUnit.castShadow = true;
                building.add(acUnit);

                // AC unit vent grills
                const grillGeometry = new THREE.PlaneGeometry(1.0, 0.6);
                const grillMaterial = new THREE.MeshStandardMaterial({
                    color: 0x4b5563, // Dark gray grill
                    roughness: 0.8
                });
                const grill = new THREE.Mesh(grillGeometry, grillMaterial);
                grill.position.set(
                    -width / 2 + unitSpacing * (i + 1),
                    yPos,
                    -depth / 2 - 0.36
                );
                grill.rotation.y = Math.PI;
                building.add(grill);
            }
        }
    }

    addRooftopUtilities(building, width, depth, yPos) {
        // Water tank (common on Philippine buildings)
        const tankGeometry = new THREE.CylinderGeometry(1.5, 1.5, 2.5, 12);
        const tankMaterial = new THREE.MeshStandardMaterial({
            color: 0x1f2937, // Dark gray/black tank
            roughness: 0.75,
            metalness: 0.3
        });
        const waterTank = new THREE.Mesh(tankGeometry, tankMaterial);
        waterTank.position.set(width / 2 - 5, yPos + 1.25, -depth / 2 + 2);
        waterTank.castShadow = true;
        building.add(waterTank);

        // Equipment room/mechanical room
        const equipRoomGeometry = new THREE.BoxGeometry(4, 2.2, 3);
        const equipRoomMaterial = new THREE.MeshStandardMaterial({
            color: 0x7DC5D9,
            roughness: 0.78
        });
        const equipRoom = new THREE.Mesh(equipRoomGeometry, equipRoomMaterial);
        equipRoom.position.set(-width / 2 + 6, yPos + 1.1, 0);
        equipRoom.castShadow = true;
        building.add(equipRoom);

        // Roof access door/hatch
        const hatchGeometry = new THREE.BoxGeometry(1.2, 0.15, 1.2);
        const hatchMaterial = new THREE.MeshStandardMaterial({
            color: 0x6b7280,
            roughness: 0.7,
            metalness: 0.4
        });
        const hatch = new THREE.Mesh(hatchGeometry, hatchMaterial);
        hatch.position.set(0, yPos + 0.075, depth / 2 - 2);
        building.add(hatch);
    }



    createRoomsForFloor(floorGroup, floorNumber, width, depth, height, yPos) {
        const roomsPerFloor = 5;
        const roomWidth = (width - 1) / roomsPerFloor;
        const roomDepth = depth - 1;

        const floorLabel = ['Ground', '2nd', '3rd', '4th'][floorNumber];

        for (let i = 0; i < roomsPerFloor; i++) {
            const roomNumber = `CCS ${(floorNumber + 2)}0${i + 1}`;
            const xPos = -width / 2 + roomWidth / 2 + i * roomWidth + 0.5;

            // Room cube (invisible, for interaction)
            const roomGeometry = new THREE.BoxGeometry(roomWidth - 0.2, height - 0.6, roomDepth - 0.2);
            const roomMaterial = new THREE.MeshStandardMaterial({
                color: 0x3b82f6,
                transparent: true,
                opacity: 0.3,
                roughness: 0.5
            });
            
            const roomMesh = new THREE.Mesh(roomGeometry, roomMaterial);
            roomMesh.position.set(xPos, yPos, 0);
            roomMesh.userData = {
                type: 'room',
                roomNumber,
                floor: floorNumber + 1,
                floorLabel,
                status: 'available', // available, occupied, scheduled
                faculty: null
            };

            // Add to rooms array for interaction
            this.rooms.push(roomMesh);
            
            roomMesh.visible = false; // Hidden by default, shown on hover
            floorGroup.add(roomMesh);

            // Window
            const windowGeometry = new THREE.PlaneGeometry(roomWidth - 1, 1.5);
            const windowMaterial = new THREE.MeshStandardMaterial({
                color: 0x93c5fd,
                transparent: true,
                opacity: 0.6,
                side: THREE.DoubleSide
            });
            const window = new THREE.Mesh(windowGeometry, windowMaterial);
            window.position.set(xPos, yPos + 0.5, depth / 2 + 0.16);
            floorGroup.add(window);
        }
    }

    extractRoomsFromModel() {
        // If using Tripo3D model, extract room meshes by name/tags
        // This depends on how the model is structured
        // For now, create interaction zones based on model bounds
        console.log('[3D Viewer] Extracting rooms from Tripo3D model...');
        
        // You can tag rooms in your Tripo3D model with specific names
        // Then search for them here:
        // this.buildingModel.traverse((child) => {
        //     if (child.name.includes('Room') || child.name.includes('Office')) {
        //         child.userData.type = 'room';
        //         this.rooms.push(child);
        //     }
        // });
    }

    setupEventListeners() {
        // Mouse move for hover effects
        this.renderer.domElement.addEventListener('mousemove', this.onMouseMove.bind(this));
        
        // Click for room selection
        if (this.options.enableInteraction) {
            this.renderer.domElement.addEventListener('click', this.onMouseClick.bind(this));
        }

        // Window resize
        window.addEventListener('resize', this.onWindowResize.bind(this));
    }

    onMouseMove(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.rooms, false);

        // Reset all rooms
        this.rooms.forEach(room => {
            room.visible = false;
            room.material.opacity = 0.3;
        });

        // Highlight hovered room
        if (intersects.length > 0) {
            const room = intersects[0].object;
            room.visible = true;
            room.material.opacity = 0.5;
            this.renderer.domElement.style.cursor = 'pointer';
        } else {
            this.renderer.domElement.style.cursor = 'default';
        }
    }

    onMouseClick(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.rooms, false);

        if (intersects.length > 0) {
            const room = intersects[0].object;
            this.onRoomSelected(room);
        }
    }

    onRoomSelected(roomMesh) {
        console.log('[3D Viewer] Room selected:', roomMesh.userData);
        
        if (this.options.onRoomClick) {
            this.options.onRoomClick(roomMesh.userData);
        }
    }

    setFloor(floorNumber) {
        this.currentFloor = floorNumber;
        
        // Filter visible rooms
        this.rooms.forEach(room => {
            if (floorNumber === 0 || room.userData.floor === floorNumber) {
                room.visible = false; // Hidden until hover
            } else {
                room.visible = false;
            }
        });

        // Move camera to floor
        if (floorNumber > 0) {
            const targetY = (floorNumber - 1) * 4 + 2;
            this.animateCameraTo(0, targetY, 0);
        } else {
            this.animateCameraTo(0, 8, 0);
        }
    }

    animateCameraTo(x, y, z, duration = 1000) {
        const startPos = this.controls.target.clone();
        const endPos = new THREE.Vector3(x, y, z);
        const startTime = Date.now();

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = this.easeInOutCubic(progress);

            this.controls.target.lerpVectors(startPos, endPos, eased);
            this.controls.update();

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };

        animate();
    }

    easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    updateRoomStatus(roomNumber, status, facultyName = null) {
        const room = this.rooms.find(r => r.userData.roomNumber === roomNumber);
        if (!room) return;

        room.userData.status = status;
        room.userData.faculty = facultyName;

        // Update room color based on status
        const colors = {
            available: 0x10b981,   // Green
            occupied: 0xef4444,    // Red
            scheduled: 0xf59e0b    // Yellow
        };

        room.material.color.setHex(colors[status] || 0x3b82f6);
    }

    onWindowResize() {
        this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }

    animate() {
        requestAnimationFrame(this.animate.bind(this));
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    destroy() {
        window.removeEventListener('resize', this.onWindowResize.bind(this));
        this.renderer.domElement.removeEventListener('mousemove', this.onMouseMove.bind(this));
        this.renderer.domElement.removeEventListener('click', this.onMouseClick.bind(this));
        this.container.removeChild(this.renderer.domElement);
        this.renderer.dispose();
    }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Building3DViewer;
}
