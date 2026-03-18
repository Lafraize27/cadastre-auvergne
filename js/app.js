(function () {
    "use strict";

    // ── Map initialization ──
    var map = L.map("map", {
        zoomControl: true,
        attributionControl: true
    }).setView([45.32, 3.42], 13);

    // Base layers
    var osmStandard = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    });

    var osmTopo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
        maxZoom: 17,
        attribution: '&copy; OpenStreetMap, SRTM | Style: &copy; OpenTopoMap'
    });

    var satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19,
        attribution: '&copy; Esri, Maxar, Earthstar Geographics'
    });

    var cadastreWMS = L.tileLayer.wms("https://data.geopf.fr/wms-v/ows", {
        layers: "CADASTRALPARCELS.PARCELLAIRE_EXPRESS",
        format: "image/png",
        transparent: true,
        maxZoom: 19,
        attribution: '&copy; IGN Cadastre'
    });

    osmStandard.addTo(map);

    L.control.layers({
        "OpenStreetMap": osmStandard,
        "Topographique": osmTopo,
        "Satellite (Esri)": satellite
    }, {
        "Cadastre IGN (WMS)": cadastreWMS
    }, { position: "topright" }).addTo(map);

    // ── Styles ──
    var styles = {
        communes: {
            color: "royalblue",
            weight: 3,
            fillColor: "royalblue",
            fillOpacity: 0.08,
            dashArray: "8 4"
        },
        parcelles: {
            color: "forestgreen",
            weight: 1,
            fillColor: "forestgreen",
            fillOpacity: 0.05
        },
        batiments: {
            color: "firebrick",
            weight: 1,
            fillColor: "firebrick",
            fillOpacity: 0.4
        },
        selection: {
            color: "darkorange",
            weight: 2.5,
            fillColor: "orange",
            fillOpacity: 0.35
        },
        highlight: {
            color: "#facc15",
            weight: 4,
            fillColor: "#fde047",
            fillOpacity: 0.5
        }
    };

    // ── Info panel ──
    var infoPanel = document.getElementById("info-panel");

    var LABELS = {
        id: "Identifiant",
        nom: "Nom",
        commune: "Code commune",
        prefixe: "Préfixe",
        section: "Section",
        numero: "Numéro",
        contenance: "Contenance (m²)",
        arpente: "Arpenté",
        type: "Type bâtiment",
        created: "Créé le",
        updated: "Mis à jour le"
    };

    // Calcul de surface d'un polygone (coordonnées lon/lat) via formule de Gauss sur ellipsoïde approx.
    function computeAreaM2(geometry) {
        var totalArea = 0;
        var polygons = [];
        if (geometry.type === "Polygon") {
            polygons = [geometry.coordinates];
        } else if (geometry.type === "MultiPolygon") {
            polygons = geometry.coordinates;
        }
        polygons.forEach(function (poly) {
            poly.forEach(function (ring, ringIndex) {
                var ringArea = 0;
                for (var i = 0; i < ring.length - 1; i++) {
                    var p1 = ring[i];
                    var p2 = ring[i + 1];
                    ringArea += toRad(p2[0] - p1[0]) * (2 + Math.sin(toRad(p1[1])) + Math.sin(toRad(p2[1])));
                }
                ringArea = Math.abs(ringArea * 6378137 * 6378137 / 2);
                totalArea += ringIndex === 0 ? ringArea : -ringArea;
            });
        });
        return Math.abs(totalArea);
    }

    function toRad(deg) { return deg * Math.PI / 180; }

    function showInfo(properties, layerName, geometry) {
        var html = '<table><tr><td colspan="2" style="color:#3b82f6;font-weight:600;padding-bottom:6px;">' + layerName + '</td></tr>';
        for (var key in properties) {
            if (properties[key] === null || properties[key] === undefined) continue;
            var label = LABELS[key] || key;
            var val = properties[key];
            if (key === "arpente") val = val ? "Oui" : "Non";
            if (key === "contenance") val = Number(val).toLocaleString("fr-FR") + " m²";
            html += "<tr><td>" + label + "</td><td>" + val + "</td></tr>";
        }
        // Ajouter la surface calculée pour les bâtiments
        if (geometry && layerName === "Bâtiment") {
            var area = computeAreaM2(geometry);
            html += '<tr><td>Surface</td><td>' + Math.round(area).toLocaleString("fr-FR") + ' m²</td></tr>';
        }
        html += "</table>";
        infoPanel.innerHTML = html;
    }

    // ── Layer interaction ──
    var currentHighlight = null;

    function resetHighlight() {
        if (currentHighlight) {
            currentHighlight.layer.setStyle(currentHighlight.originalStyle);
            currentHighlight = null;
        }
    }

    function onFeatureClick(e, style, layerName) {
        resetHighlight();
        var layer = e.target;
        currentHighlight = { layer: layer, originalStyle: Object.assign({}, style) };
        layer.setStyle(styles.highlight);
        layer.bringToFront();
        showInfo(layer.feature.properties, layerName, layer.feature.geometry);
    }

    // ── Load GeoJSON layers ──
    var layers = {};
    var layerNames = {
        communes: "Commune",
        parcelles: "Parcelle",
        batiments: "Bâtiment",
        parcelles_filtrees: "Parcelle sélectionnée"
    };
    var layerFiles = ["communes", "parcelles", "batiments", "parcelles_filtrees"];
    var layerStyleKeys = ["communes", "parcelles", "batiments", "selection"];
    var checkboxIds = ["layer-communes", "layer-parcelles", "layer-batiments", "layer-selection"];

    // Mapping code commune -> nom
    var COMMUNE_NAMES = {
        "43175": "Saint-Cirgues",
        "43118": "Lavoûte-Chilhac",
        "43031": "Blassac"
    };

    // Stockage des sous-couches individuelles pour parcelles filtrées
    var filteredParcelLayers = []; // { layer, id, visible }

    var loaded = 0;

    layerFiles.forEach(function (name, i) {
        var styleKey = layerStyleKeys[i];
        fetch("data/" + name + ".geojson")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var layerOptions = {
                    style: function () { return styles[styleKey]; }
                };

                // Communes = contours non-interactifs pour ne pas bloquer les clics
                if (name === "communes") {
                    layerOptions.interactive = false;
                } else {
                    layerOptions.onEachFeature = function (_feature, layer) {
                        layer.on("click", function (e) {
                            onFeatureClick(e, styles[styleKey], layerNames[name]);
                            L.DomEvent.stopPropagation(e);
                        });
                    };
                }

                var geojsonLayer = L.geoJSON(data, layerOptions);

                layers[name] = geojsonLayer;

                // Add to map (batiments off by default, parcelles_filtrees on top)
                if (name === "batiments") {
                    // Ne pas ajouter par défaut
                } else {
                    geojsonLayer.addTo(map);
                    if (name === "parcelles_filtrees") {
                        geojsonLayer.bringToFront();
                        buildParcellesList(geojsonLayer);
                    }
                }

                loaded++;
                if (loaded === layerFiles.length) {
                    if (layers.communes) {
                        map.fitBounds(layers.communes.getBounds(), { padding: [20, 20] });
                    }
                    if (layers.parcelles) layers.parcelles.bringToBack();
                    if (layers.communes) layers.communes.bringToBack();
                }

                // Bind checkbox
                var checkbox = document.getElementById(checkboxIds[i]);
                if (checkbox) {
                    checkbox.addEventListener("change", function () {
                        if (this.checked) {
                            map.addLayer(geojsonLayer);
                            // Si c'est la couche sélection, réafficher les parcelles individuelles cochées
                            if (name === "parcelles_filtrees") {
                                filteredParcelLayers.forEach(function (item) {
                                    if (item.visible) item.layer.addTo(map);
                                });
                            }
                        } else {
                            map.removeLayer(geojsonLayer);
                            if (name === "parcelles_filtrees") {
                                filteredParcelLayers.forEach(function (item) {
                                    map.removeLayer(item.layer);
                                });
                            }
                        }
                    });
                }
            })
            .catch(function (err) {
                console.error("Erreur chargement " + name + ":", err);
            });
    });

    // ── Build parcelles filtrées list ──
    function buildParcellesList(geojsonLayer) {
        var listContainer = document.getElementById("parcelles-list");
        var selectAll = document.getElementById("select-all-parcelles");

        // Collect and sort features
        var items = [];
        geojsonLayer.eachLayer(function (layer) {
            var p = layer.feature.properties;
            var communeName = COMMUNE_NAMES[p.commune] || p.commune;
            var label = communeName + " - " + p.section + " n\u00b0 " + p.numero;
            var id = p.commune + "_" + p.section + "_" + p.numero;
            items.push({ layer: layer, label: label, id: id, commune: communeName, section: p.section, numero: parseInt(p.numero, 10) });
        });

        // Sort by commune, section, numero
        items.sort(function (a, b) {
            if (a.commune !== b.commune) return a.commune.localeCompare(b.commune);
            if (a.section !== b.section) return a.section.localeCompare(b.section);
            return a.numero - b.numero;
        });

        // Build checkboxes
        items.forEach(function (item) {
            var lbl = document.createElement("label");
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = true;
            cb.dataset.parcelId = item.id;
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(" " + item.label));
            listContainer.appendChild(lbl);

            filteredParcelLayers.push({ layer: item.layer, id: item.id, visible: true });

            cb.addEventListener("change", function () {
                var entry = filteredParcelLayers.find(function (e) { return e.id === item.id; });
                if (cb.checked) {
                    entry.visible = true;
                    item.layer.addTo(map);
                    item.layer.setStyle(styles.selection);
                } else {
                    entry.visible = false;
                    map.removeLayer(item.layer);
                }
                updateSelectAllState();
            });

            // Click on label text zooms to parcelle
            lbl.addEventListener("dblclick", function (e) {
                e.preventDefault();
                map.fitBounds(item.layer.getBounds(), { maxZoom: 18, padding: [50, 50] });
                resetHighlight();
                currentHighlight = { layer: item.layer, originalStyle: Object.assign({}, styles.selection) };
                item.layer.setStyle(styles.highlight);
                item.layer.bringToFront();
                showInfo(item.layer.feature.properties, "Parcelle sélectionnée", item.layer.feature.geometry);
            });
        });

        // Select all / deselect all
        selectAll.addEventListener("change", function () {
            var checked = selectAll.checked;
            var checkboxes = listContainer.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(function (cb) {
                cb.checked = checked;
            });
            filteredParcelLayers.forEach(function (entry) {
                entry.visible = checked;
                if (checked) {
                    entry.layer.addTo(map);
                    entry.layer.setStyle(styles.selection);
                } else {
                    map.removeLayer(entry.layer);
                }
            });
        });

        function updateSelectAllState() {
            var checkboxes = listContainer.querySelectorAll('input[type="checkbox"]');
            var allChecked = true;
            checkboxes.forEach(function (cb) {
                if (!cb.checked) allChecked = false;
            });
            selectAll.checked = allChecked;
        }
    }

    // ── Search ──
    var btnSearch = document.getElementById("btn-search");
    var searchResult = document.getElementById("search-result");

    btnSearch.addEventListener("click", function () {
        var commune = document.getElementById("search-commune").value;
        var section = document.getElementById("search-section").value.trim().toUpperCase();
        var numero = document.getElementById("search-numero").value.trim();

        if (!commune || !section || !numero) {
            searchResult.textContent = "Veuillez remplir tous les champs.";
            return;
        }

        searchResult.textContent = "Recherche...";

        var found = null;
        if (layers.parcelles) {
            layers.parcelles.eachLayer(function (layer) {
                var p = layer.feature.properties;
                if (p.commune === commune && p.section === section && String(p.numero) === numero) {
                    found = layer;
                }
            });
        }

        if (found) {
            searchResult.textContent = "Parcelle trouvée !";
            resetHighlight();
            currentHighlight = { layer: found, originalStyle: Object.assign({}, styles.parcelles) };
            found.setStyle(styles.highlight);
            found.bringToFront();
            map.fitBounds(found.getBounds(), { maxZoom: 18, padding: [50, 50] });
            showInfo(found.feature.properties, "Parcelle", found.feature.geometry);
        } else {
            searchResult.textContent = "Parcelle non trouvée.";
        }
    });

    // Enter key in search fields
    ["search-section", "search-numero"].forEach(function (id) {
        document.getElementById(id).addEventListener("keydown", function (e) {
            if (e.key === "Enter") btnSearch.click();
        });
    });

    // ── Sidebar toggle ──
    var sidebar = document.getElementById("sidebar");
    var toggleBtn = document.getElementById("sidebar-toggle");

    toggleBtn.addEventListener("click", function () {
        sidebar.classList.toggle("collapsed");
        setTimeout(function () { map.invalidateSize(); }, 300);
    });

    // Click on map resets info
    map.on("click", function () {
        resetHighlight();
        infoPanel.innerHTML = '<p class="hint">Cliquez sur un élément de la carte pour afficher ses informations.</p>';
    });
})();
