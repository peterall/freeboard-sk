import { Component, ViewChild } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { DomSanitizer, SafeResourceUrl} from '@angular/platform-browser';

import { AppInfo } from './app.info';
import { AboutDialog, LoginDialog } from './lib/app-ui';
import { PlaybackDialog } from './lib/ui/playback-dialog';

import { SettingsDialog, AlarmsFacade, AlarmsDialog, 
        SKStreamFacade, SKSTREAM_MODE, SKResources, SKVessel, 
        SKRegion, AISPropertiesDialog, GPXImportDialog } from './modules';

import { SignalKClient } from 'signalk-client-angular';
import { Convert } from './lib/convert';
import 'hammerjs';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {

    @ViewChild('sideright', {static: false}) sideright;

    public display= {
        badge: { hide: true, value: '!'},
        leftMenuPanel: false,
        instrumentPanelOpen: true,
        instrumentAppActive: true,
        routeList: false,
        waypointList: false,
        chartList: false,
        noteList: false,     
        aisList: false,
        anchorWatch: false,
        navDataPanel: {
            show: false,
            nextPointCtrl: false
        },
        playback: { time: null },
        map: { center: [0,0] }
    }

    public draw= {
        enabled: false,
        mode: null,
        type: null,
        modify: false,
        forSave: null,
        properties: {}
    }

    public measure= { enabled: false } 

    // ** APP features / mode **
    public features= { playbackAPI: true }
    public mode: SKSTREAM_MODE= SKSTREAM_MODE.REALTIME;   // current mode

    private timers= [];

    private lastInstUrl: string;
    public instUrl: SafeResourceUrl;
    
    public convert= Convert;
    private obsList= [];    // observables array
    private streamOptions= {options: null, toMode: null};
    
    constructor(
                public app: AppInfo, 
                public alarmsFacade: AlarmsFacade,
                private stream: SKStreamFacade,
                public skres: SKResources,
                public signalk: SignalKClient,
                private dom: DomSanitizer,
                private dialog: MatDialog) { 
        // set self to active vessel
        this.app.data.vessels.active= this.app.data.vessels.self
    }

   // ********* LIFECYCLE ****************

    ngAfterViewInit() { if(this.app.data['firstRun']) { setTimeout( ()=> { this.showWelcome()}, 500) } }

    ngOnInit() {
        // ** apply loaded app config	
        this.display.map.center= this.app.config.map.center;
        if(this.app.config.plugins.startOnOpen) { this.display.instrumentAppActive= false }

        this.lastInstUrl= this.app.config.plugins.instruments;
        this.instUrl= this.dom.bypassSecurityTrustResourceUrl(`${this.app.host}${this.app.config.plugins.instruments}`);            

        // ** connect to signalk server and intialise
        this.connectSignalKServer(); 

        // ********************* SUBSCRIPTIONS *****************
        // ** SIGNAL K STREAM **
        this.obsList.push( this.stream.delta$().subscribe( msg=> this.onMessage(msg) ) );
        this.obsList.push( this.stream.connect$().subscribe( msg=> this.onConnect(msg) ) );
        this.obsList.push( this.stream.close$().subscribe( msg=> this.onClose(msg) ) );
        this.obsList.push( this.stream.error$().subscribe( msg=> this.onError(msg) ) );
        // ** COURSE DATA **
        this.obsList.push( this.skres.activeRoute$().subscribe ( msg=> { this.updateNavPanel(msg) }));
        // ** RESOURCES update event
        this.obsList.push( this.skres.update$().subscribe( value=> this.handleResourceUpdate(value) ) );
        // ** SETTINGS - handle settings load / save events
        this.obsList.push( this.app.settings$.subscribe( r=> this.handleSettingsEvent(r) ) );        

        // ** NOTIFICATIONS - Anchor Status **
        this.obsList.push( 
            this.alarmsFacade.anchorStatus$().subscribe(
                r=> {
                    if(r.error) { 
                        if( r.result== 401) { this.showLogin() }
                        else { 
                            this.app.showAlert(
                                'Anchor Watch:', 
                                'Server returned an error. This function may not be supported by yor server.'
                            );
                        }
                    }
                }
            )
        );
    } 

    ngOnDestroy() {
        // ** clean up
        this.stopTimers();
        this.stream.terminate();
        this.signalk.disconnect();
        this.obsList.forEach( i=> i.unsubscribe() );
    }

    // ** show welcome message on first run **
    private showWelcome() {
        let title: string= 'Welcome to Freeboard';
        let message: string;
        if(this.app.data.server && this.app.data.server.id=='signalk-server-node') {
            message='Node version of Signal K server detected!\n\n';
            message+='For all Freeboard features to operate ensure the server has plugins ';
            message+='that can service the following Signal K API paths:\n';
            message+='- resources/routes, resources/waypoints\n';
            message+='- resources/charts\n';
            message+='- navigation/anchor, navigation/courseGreatCircle/activeRoute';
        }
        else {
            message='- View Routes, Waypoints and Charts available on your Signal K server\n';
            message+='- Add, delete and manage Routes and Waypoints\n';
            message+='- Set Anchor Watch alarms and display Depth alarms\n';
        }
        this.app.data['firstRun']=false;
        this.app.showAlert(message, title, 'Continue');         
    }

    // ** establish connection to server
    private connectSignalKServer() {
        this.app.data.selfId= null;
        this.app.data.server= null;
        this.signalk.connect(this.app.hostName, this.app.hostPort, this.app.hostSSL)
        .then( ()=> { 
            this.app.data.server= this.signalk.server.info; 
            this.openSKStream();
        })
        .catch( err=> {
            this.app.showAlert(
                'Connection Error:',  
                'Unable to contact Signal K server!', 
                'Try Again'
            ).subscribe( ()=>{ this.connectSignalKServer() } );
        });
    } 

    // ** start trail / AIS timers
    private startTimers() {
        // ** start trail logging interval timer
        this.app.debug(`Starting Trail logging timer...`);
        this.timers.push( setInterval( ()=> { this.processTrail() }, 5000 ) );
    }
    // ** stop timers
    private stopTimers() {
        this.app.debug(`Stopping timers:`);
        this.timers.forEach( t=> clearInterval(t) );
        this.timers= [];
    }

    // ** process vessel trail **
    private processTrail() {
        if(!this.app.config.vesselTrail) { return }
        // ** update vessel trail **
        let t= this.app.data.trail.slice(-1);
        if(t.length==0) { 
            this.app.data.trail.push(this.app.data.vessels.active.position);
            return;
        }
        if( this.app.data.vessels.active.position[0]!=t[0][0] ||
                this.app.data.vessels.active.position[1]!=t[0][1] ) {
            this.app.data.trail.push(this.app.data.vessels.active.position) 
        }
        this.app.data.trail= this.app.data.trail.slice(-5000);  
        let trailId= (this.mode==SKSTREAM_MODE.PLAYBACK) ? 'history' : 'self';
        this.app.db.saveTrail(trailId, this.app.data.trail);
    }    

    // ** RESOURCES event handlers **
    private handleResourceUpdate(e:any) {
        // ** handle routes get
        if(e.action=='get' && e.mode=='route') { this.updateNavPanel(e) }
        // ** create note in group **
        if(e.action=='new' && e.mode=='note') { 
            if(this.app.config.resources.notes.groupRequiresPosition) {
                this.drawStart(e.mode, {group: e.group}) 
            }
            else { 
                this.skres.showNoteEditor({group: e.group});                
            }
        }
    }   
    
    // ** SETTINGS event handler **
    private handleSettingsEvent(e:any) {
        this.app.debug(`App: settings.update$`,'warn');
        if(e.action=='load' && e.setting=='config') {
            this.app.data.trueMagChoice= this.app.config.selections.headingAttribute;
        }
        if(e.action=='save' && e.setting=='config') {
            if(this.app.data.trueMagChoice!= this.app.config.selections.headingAttribute) {
                this.app.debug('True / Magnetic selection changed..');
                this.app.data.vessels.self.heading= this.app.useMagnetic ? 
                    this.app.data.vessels.self.headingMagnetic : 
                    this.app.data.vessels.self.headingTrue;
                this.app.data.vessels.self.cog= this.app.useMagnetic ? 
                    this.app.data.vessels.self.cogMagnetic : 
                    this.app.data.vessels.self.cogTrue;
                this.app.data.vessels.self.wind.direction= this.app.useMagnetic ? 
                    this.app.data.vessels.self.wind.mwd : 
                    this.app.data.vessels.self.wind.twd;

                this.app.data.vessels.aisTargets.forEach( (v,k)=> {
                    v.heading= this.app.useMagnetic ? 
                        v.headingMagnetic : 
                        v.headingTrue; 
                    v.cog= this.app.useMagnetic ? 
                        v.cogMagnetic : 
                        v.cogTrue;
                    v.wind.direction= this.app.useMagnetic ? 
                        v.wind.mwd : 
                        v.wind.twd;
                });
                this.app.data.trueMagChoice= this.app.config.selections.headingAttribute;
            };

            if(this.lastInstUrl!= this.app.config.plugins.instruments) {
                this.lastInstUrl= this.app.config.plugins.instruments
                this.instUrl= this.dom.bypassSecurityTrustResourceUrl(`${this.app.host}${this.app.config.plugins.instruments}`);
            }                
        }    
        // update instrument app state
        if(this.app.config.plugins.startOnOpen) {
            if(!this.display.instrumentPanelOpen) { this.display.instrumentAppActive= false }
        }
        else { this.display.instrumentAppActive= true }        
    }


    // ********* SIDENAV ACTIONS *************
  
    public rightSideNavAction(e:boolean) {
        this.display.instrumentPanelOpen= e;
        if(this.app.config.plugins.startOnOpen) {
            this.display.instrumentAppActive= e;
        }
    }

    public displayLeftMenu( menulist:string='', show:boolean= false) {
        this.display.leftMenuPanel= show;
        this.display.routeList= false;
        this.display.waypointList= false; 
        this.display.chartList= false;
        this.display.noteList= false;
        this.display.aisList= false;
        this.display.anchorWatch= false;
        switch (menulist) {
            case 'routeList': 
                this.display.routeList= show;
                break;
            case 'waypointList': 
                this.display.waypointList= show;
                break;   
            case 'chartList': 
                this.display.chartList= show;
                break;  
            case 'noteList': 
                this.display.noteList= show;
                break;                                   
            case 'anchorWatch': 
                this.display.anchorWatch= show;
                break;    
            case 'aisList': 
                this.display.aisList= show;
                break;                                                   
            default: 
                this.display.leftMenuPanel= false;     
        }
    }    

    // ********* MAIN MENU ACTIONS *************

    // ** open about dialog **
    public openAbout() { 
        this.dialog.open(AboutDialog, {
            disableClose: false,
            data: {
                name: this.app.name,  
                version: this.app.version, 
                description: this.app.description, 
                logo: this.app.logo,  
                url: this.app.url
            }
        });  
    }  

    // ** open settings dialog **
    public openSettings() {  this.dialog.open( SettingsDialog, { disableClose: false }) }      

    // ** GPX File processing **
    public processGPX(e:any) {
        this.dialog.open(GPXImportDialog, {
            disableClose: true,
            data: { 
                fileData: e.data,
                fileName: e.name
            }
        }).afterClosed().subscribe( errCount=> {
            if(errCount<0) { return } // cancelled
            this.skres.getRoutes(this.app.data.vessels.activeId);
            this.skres.getWaypoints();  
            if(errCount==0) { this.app.showAlert('GPX Load','GPX file resources loaded successfully.') }
            else { this.app.showAlert('GPX Load','Completed with errors!\nNot all resources were loaded.') }
        });       
    }

    // ** show login dialog **
    public showLogin(message?:string, cancelWarning:boolean=true, onConnect?:boolean) {
        this.dialog.open(LoginDialog, {
            disableClose: true,
            data: { message: message || 'Login to Signal K server.'}
        }).afterClosed().subscribe( res=> {
            if(!res.cancel) {
                this.signalk.login(res.user, res.pwd).subscribe(
                    r=> {   // ** authenticated
                        this.signalk.authToken= r['token'];
                        this.app.db.saveAuthToken(r['token']);
                        this.app.data.hasToken= true; // hide login menu item
                        if(onConnect) { this.queryAfterConnect() }
                    },
                    err=> {   // ** auth failed
                        this.app.data.hasToken= false; // show login menu item
                        if(onConnect) { 
                            this.app.showConfirm(
                                'Invalid Username or Password.', 
                                'Authentication Failed:',
                                'Try Again'
                            ).subscribe( r=> { this.showLogin(null, false, true) });
                        }
                        else { 
                            this.app.showConfirm(
                                'Invalid Username or Password.\nNote: Choosing CLOSE may make operations requiring authentication unavailable.', 
                                'Authentication Failed:',
                                'Try Again',
                                'Close'
                            ).subscribe( r=> { if(r) { this.showLogin() } }); 
                        }
                    }
                );
            }
            else { 
                this.app.data.hasToken= false; // show login menu item
                if(onConnect) { this.showLogin(null, false, true) }
                else {
                    if(cancelWarning) {
                        this.app.showAlert(
                            'Login Cancelled:', 
                            `Update operations are NOT available until you have authenticated to the Signal K server.`);
                    }
                }
            }
        });        
    }

    public showPlaybackSettings() {
        this.dialog.open(PlaybackDialog, {
            disableClose: false
        }).afterClosed().subscribe( r=> {
            if(r.result) { // OK: switch to playback mode
                this.switchMode(SKSTREAM_MODE.PLAYBACK, r.query);
            }
            else {  // cancel: restarts realtime mode
                this.switchMode(SKSTREAM_MODE.REALTIME);
            }
        });
    }
 

    // ********** TOOLBAR ACTIONS **********

    public openAlarmsDialog() { this.dialog.open(AlarmsDialog, { disableClose: true }) }

    public toggleMoveMap(exit:boolean=false) { 
        let doSave:boolean= (!this.app.config.map.moveMap && exit) ? false : true;
        this.app.config.map.moveMap= (exit) ? false : !this.app.config.map.moveMap;
        if(doSave) { this.app.saveConfig() }
    }

    public toggleNorthUp() { 
        this.app.config.map.northUp= !this.app.config.map.northUp;
        this.app.saveConfig();
    } 

    // ***** EDIT MENU ACTONS *******

    // ** Enter Draw mode **
    public drawStart(mode:string, props?:any) {
        this.draw.properties= (props && props.group) ? props : {};
        this.draw.mode= mode;
        this.draw.enabled= true;
    }

    // ** Enter Measure mode **
    public measureStart() { this.measure.enabled=true } 

    // ***** OPTIONS MENU ACTONS *******  

    public centerVessel() { 
        let t=this.app.data.vessels.active.position;
        t[0]+=0.0000000000001;
        this.display.map.center= t;
    }

    public toggleAisTargets() { 
        this.app.config.aisTargets= !this.app.config.aisTargets;
        if(this.app.config.aisTargets) { this.processAIS(true) }
        this.app.saveConfig();
    }

    public toggleCourseData() { 
        this.app.config.courseData= !this.app.config.courseData;
        this.app.saveConfig();
    }  
    
    public toggleNotes() { 
        this.app.config.notes= !this.app.config.notes;
        this.app.saveConfig();
    }     

    // ** delete vessel trail **
    public clearTrail(noprompt:boolean=false) {
        if(noprompt) { this.app.data.trail=[] }
        else {
            this.app.showConfirm(
                'Clear Vessel Trail',
                'Do you want to delete the vessel trail?'
            ).subscribe( res=> { if(res) this.app.data.trail=[] }); 
        }   
    }

    // ** clear course / navigation data **
    public clearCourseData() {
        let idx= this.app.data.navData.pointIndex;
        this.app.data.navData= {
            vmg: null,
            dtg: null,
            ttg: null,
            bearing: {value: null, type: null},
            bearingTrue: null,
            bearingMagnetic: null,
            xte: null,
            position: [null, null],
            pointIndex: idx,
            pointTotal: 0
        }
    }

    // ** clear active destination **
    public deactivateRoute() { 
        if(this.app.data.activeRoute) { 
            this.skres.clearActiveRoute(this.app.data.vessels.activeId);
        }
        else {
            this.skres.setNextPoint(null);
            this.app.data.activeWaypoint= null;
        }
        
    }   

    // ********** MAP / UI ACTIONS **********

    // ** set active route **
    public activateRoute(id:string) { this.skres.activateRoute(id, this.app.data.vessels.activeId) }   
   
    // ** Set active route as nextPoint **
    public routeNextPoint(i:number) {
        let c= this.skres.getActiveRouteCoords();
        if(i==-1) {
            if(this.app.data.navData.pointIndex==-1) {
                this.app.data.navData.pointIndex=0;
            }
            else if(this.app.data.navData.pointIndex>0) {
                this.app.data.navData.pointIndex--;
            }
            else { return }
        }
        else { // +1
            if(this.app.data.navData.pointIndex==-1) {
                this.app.data.navData.pointIndex= c.length-1;
            }
            else if(this.app.data.navData.pointIndex<this.app.data.navData.pointTotal-1) {
                this.app.data.navData.pointIndex++;
            }
            else { return }
        }
        let nextPoint= {
            latitude: c[this.app.data.navData.pointIndex][1], 
            longitude: c[this.app.data.navData.pointIndex][0], 
        }
        this.skres.setNextPoint(nextPoint);     
    }     

    // ** handle display vessel properties **
    public vesselProperties(e:any) {
        let v: any;
        if(e.type=='self') { v= this.app.data.vessels.self }
        else { v= this.app.data.vessels.aisTargets.get(e.id) }
        if(v) {
            this.dialog.open(AISPropertiesDialog, {
                disableClose: true,
                data: {
                    title: 'Vessel Properties',
                    target: v
                }
            });
        }
    }   
    
    // ** handle drag and drop of files onto map container**
    public mapDragOver(e:any) { e.preventDefault() }

    public mapDrop(e:any) {  
        e.preventDefault();
        if (e.dataTransfer.files) {
            if( e.dataTransfer.files.length>1 ) { 
                this.app.showAlert('Load Resources', 'Multiple files provided!\nPlease select only one file for processing.');
            }
            else {
                let reader = new FileReader();
                reader.onerror= err=> { 
                    this.app.showAlert('File Load error', `There was an error reading the file contents!`);
                }  
                if(!e.dataTransfer.files[0].name) { return }  
                let fname= e.dataTransfer.files[0].name;            
                reader.onload= ()=> { this.processGPX({ name: fname, data: reader.result}) }
                reader.readAsText(e.dataTransfer.files[0]);
            }
        } 
    }  

    // ** process / cleanup AIS targets
    private processAIS(toggled?: boolean) {
        if(!this.app.config.aisTargets && !toggled) { return }
        if(toggled) { // ** re-populate list after hide
            this.app.data.vessels.aisTargets.forEach( (v,k)=>{
                this.app.data.aisMgr.updateList.push(k);
            });
        }
    }
    
    // ********* MODE ACTIONS *************

    // ** set the active vessel to the supplied UUID **
    public switchActiveVessel(uuid: string=null) {
        this.app.data.vessels.activeId= uuid;
        if(!uuid) { this.app.data.vessels.active= this.app.data.vessels.self }
        else {
            let av= this.app.data.vessels.aisTargets.get(uuid);
            if(!av) {
                this.app.data.vessels.active= this.app.data.vessels.self;
                this.app.data.vessels.activeId= null;
            }
            else { 
                this.app.data.vessels.active= av;
                // if instrument panel open - close it
                this.sideright.close();
            }
        }
        this.app.data.activeRoute= null;
        this.clearTrail(true);
        this.clearCourseData();
        this.alarmsFacade.queryAnchorStatus(this.app.data.vessels.activeId, this.app.data.vessels.active.position);
        this.skres.getRoutes(uuid); // get activeroute from active vessel
        this.alarmsFacade.alarms.clear(); // reset displayed alarm(s)

        this.app.debug(`** Active vessel: ${this.app.data.vessels.activeId} `);
        this.app.debug(this.app.data.vessels.active);
    }

    // ** switch between realtime and history playback modes
    public switchMode(toMode: SKSTREAM_MODE, query:any='none') {
        this.app.debug(`switchMode from: ${this.mode} to ${toMode}`);
        if(toMode== SKSTREAM_MODE.PLAYBACK) { // ** history playback
            this.app.db.saveTrail('self', this.app.data.trail);
            this.app.data.trail= [];
        }
        else {  // ** realtime data
            this.app.db.getTrail('self').then( t=> { 
                this.app.data.trail= (t && t.value) ? t.value : [];
            });
        }
        this.switchActiveVessel();
        this.openSKStream(query, toMode, true);
    }   
    
    // ** show select mode dialog
    public showSelectMode() {
        if(this.mode== SKSTREAM_MODE.REALTIME) { // request history playback
            this.app.showConfirm(
                'Do you want to change to History Playback mode?', 
                'Switch Mode' 
            ).subscribe( r=> { if(r) { this.showPlaybackSettings() } });         
        }
        else {  // request realtime
            this.app.showConfirm(
                'Do you want to exit History Playback mode?', 
                'Exit History Playback' 
            ).subscribe( r=> { if(r) { this.switchMode(SKSTREAM_MODE.REALTIME) } });  
        }
    }    

    // ******** DRAW / EDIT EVENT HANDLERS ************

    // ** handle modify start event **
    public handleModifyStart(e:any) {
        this.draw.type= null
        this.draw.mode= null;
        this.draw.enabled= false;
        this.draw.modify= true;      
        this.draw.forSave= { id: null, coords: null}  
    }

    // ** handle modify end event **
    public handleModifyEnd(e:any) {
        this.draw.forSave= e;
        this.app.debug(this.draw.forSave);
    }  
     
    // ** Draw end event **
    public handleDrawEnd(e:any) {
        this.draw.enabled=false;
        switch(this.draw.mode) {
            case 'note':   
                let params= {position: e.coordinates};
                if(this.draw.properties['group']) { params['group']= this.draw.properties['group'];}
                this.skres.showNoteEditor(params);
                break;
            case 'waypoint':         
                this.skres.showWaypointEditor({position: e.coordinates});
                break;
            case 'route':
                this.skres.showRouteNew({coordinates: e.coordinates});
                break;
            case 'region':  // region + Note
                let region= new SKRegion();
                let uuid= this.signalk.uuid.toSignalK();
                region.feature.geometry.coordinates= [e.coordinates];
                this.skres.showNoteEditor({region: {id:uuid, data: region }})
                break;                
        }
        //e.mode=='ended' // draw mode was ended by user
        // clean up
        this.draw.mode=null;
        this.draw.modify=false;
    }
      
    // ** End Draw / modify / Measure mode **
    public cancelDraw() {
        if(this.draw.modify && this.draw.forSave && this.draw.forSave.id) {  // save changes
            this.app.showConfirm(
                `Do you want to save the changes made to ${this.draw.forSave.id.split('.')[0]}?`, 
                'Save Changes'
            ).subscribe( res=> {
                let r= this.draw.forSave.id.split('.');
                if(res) {   // save changes
                    if(r[0]=='route') { 
                        this.skres.updateRouteCoords(r[1], this.draw.forSave.coords);
                        this.stream.updateNavData(this.draw.forSave.coords); 
                    }
                    if(r[0]=='waypoint') {
                        this.skres.updateWaypointPosition(r[1], this.draw.forSave.coords);
                        this.skres.setNextPoint({
                            latitude: this.draw.forSave.coords[1], 
                            longitude: this.draw.forSave.coords[0], 
                        });  
                    }
                    if(r[0]=='note') { 
                        this.skres.updateNotePosition(r[1], this.draw.forSave.coords);
                    }         
                    if(r[0]=='region') { 
                        this.skres.updateRegionCoords(r[1], this.draw.forSave.coords);
                    }                                 
                }
                else {
                    if(r[0]=='route') { this.skres.getRoutes(this.app.data.vessels.activeId) }
                    if(r[0]=='waypoint') { this.skres.getWaypoints() }
                    if(r[0]=='note' || r[0]=='region') { this.skres.getNotes() }
                }
                this.draw.forSave= null;
            });
        }
        // clean up
        this.draw.enabled=false;
        this.draw.mode=null;
        this.draw.modify=false;
        this.measure.enabled=false;
    }  

    // ******** SIGNAL K STREAM *************

    // ** open WS Stream 
    private openSKStream(options:any=null, toMode: SKSTREAM_MODE=SKSTREAM_MODE.REALTIME, restart:boolean=false) { 
        if(restart) {
            this.streamOptions= {options:options, toMode: toMode};
            this.stream.close();
            return;
        }
        this.stream.open(options, toMode);
    }

    // ** query server for current values **
    private queryAfterConnect() {
        // ** get vessel details
        let context= (this.app.data.vessels.activeId) ? 
            this.app.data.vessels.activeId.split('.').join('/') : 'vessels/self';
        this.signalk.api.getSelf().subscribe(
            r=> {  
                this.app.data.vessels.self.mmsi= (r['mmsi']) ? r['mmsi'] : null;
                this.app.data.vessels.self.name= (r['name']) ? r['name'] : null;
                // ** query navigation status
                this.signalk.api.get(`/${context}/navigation`).subscribe(
                    r=> {
                        let c;
                        if( r['courseRhumbline'] ) { c= r['courseRhumbline'] }
                        if( r['courseGreatCircle'] ) { c= r['courseGreatCircle'] }
                        if( c && c['activeRoute'] && c['activeRoute']['href']) { 
                            this.stream.processActiveRoute( c['activeRoute']['href'].value );
                        }          
                    },
                    err=> { this.app.debug('No navigation data available!') }
                ); 
                // ** query for resources
                this.skres.getRoutes(this.app.data.vessels.activeId);
                this.skres.getWaypoints();
                this.skres.getCharts();  
                this.skres.getNotes();
                // ** query anchor alarm status
                this.alarmsFacade.queryAnchorStatus(this.app.data.vessels.activeId, this.app.data.vessels.active.position);              
            },
            err=> { 
                if(err.status && err.status==401) { this.showLogin(null, false, true) }  
                this.app.debug('No vessel data available!') 
            }
        );          
    }

    // ** handle connection established
    private onConnect(e?:any) {
        this.app.showMessage('Connection Open.', false, 2000);
        this.app.debug(e);
        // ** query server for status
        this.queryAfterConnect();
        // ** start trail timer
        this.startTimers();
    }

    // ** handle connection closure
    private onClose(e?:any) {
        this.app.debug('onClose: STREAM connection closed...');
        this.app.debug(e);
        this.stopTimers();
        if(e.result) { // closed by command then restart
            this.openSKStream(this.streamOptions.options, this.streamOptions.toMode);
        }
        else {
            let data= { title: 'Connection Closed:', buttonText: 'Re-connect', message: ''};
            if(e.playback) { 
                data.buttonText= 'OK'
                data.message= 'Unable to open Playback connection.';
            }
            else { data.message= 'Connection to the Signal K server has been closed.'}  

            this.app.showAlert(
                data.message,
                data.title,
                data.buttonText
            ).subscribe( ()=>{ 
                if(this.mode==SKSTREAM_MODE.REALTIME) { this.switchMode(this.mode) } 
                else { this.showPlaybackSettings() }
            });
        }  
    }
    
    // ** handle error message
    private onError(e:any) { 
        this.app.showMessage('Connection Error!', false, 2000);
        console.warn('Stream Error!', e);
    }
    
    // ** handle delta message received
    private onMessage(e: any) { 
        if(e.action=='hello') { // ** hello message
            this.app.debug(e); 
            if(e.playback) { this.mode= SKSTREAM_MODE.PLAYBACK }
            else { 
                this.mode= SKSTREAM_MODE.REALTIME;
                this.stream.subscribe();
            }
            this.app.data.selfId= e.self;
            return;
        }
        else if(e.action=='update') { // delta message
            if(this.mode==SKSTREAM_MODE.PLAYBACK) { 
                let d= new Date(e.timestamp);
                this.display.playback.time= `${d.toDateString().slice(4)} ${d.toTimeString().slice(0,8)}`;
            }   
            else { this.display.playback.time= null }   
        }  
    }   

    // ** Update NavData Panel display **
    private updateNavPanel(msg?:any) {
        if(msg) {
            if(msg.action=='clear') { this.display.navDataPanel.show= false }
            if(msg.action=='next') { 
                this.display.navDataPanel.show= (msg.value) ? true : false;
                this.app.data.navData.position= msg.value;
            }
            if(msg.mode=='route' && msg.action=='get') { 
                this.display.navDataPanel.show= (this.app.data.activeRoute) ? true : false;
            }
        }
        if(this.app.data.activeRoute) { this.stream.updateNavData(this.skres.getActiveRouteCoords()) }
        
        this.display.navDataPanel.show= (this.app.data.navData.position) ? true : false;
        this.display.navDataPanel.nextPointCtrl= (this.app.data.activeRoute) ? true : false;
    }

}
