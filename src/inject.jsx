import React from 'react';
import PropTypes from 'prop-types';
import axios from 'axios';
import { bindActionCreators } from 'redux';
import { connect } from 'react-redux';
import { Map, Set } from 'immutable';
import { HubConnectionBuilder, HttpTransportType } from '@aspnet/signalr';

function getDisplayName(Component) {
  return Component.displayName || Component.name || 'Component';
}

export default function injectSignalR(
  WrappedComponent,
  options = {
    hubName: '',
    baseAddress: undefined,
    accessToken: undefined,
    signalrPath: 'signalr',
    controller: '',
    retries: 3,
  },
) {
  const {
    hubName = '',
    baseAddress = 'http://localhost:5555',
    accessToken = null,
    signalrPath = 'signalr',
    retries = 3,
  } = options;
  const { controller = hubName } = options;

  const getValueFromState = (state, source) => {
    if (typeof source === 'function') {
      return source(state);
    } else if (typeof source === 'string') {
      return source;
    }
    return '';
  };

  const invokeController = (address, target, data = undefined) => {
    const urlBase = `${address}/${controller}/${target}`;
    const url = data ? `${urlBase}/${data}` : urlBase;
    return axios.get(url)
      .catch((err) => {
        console.error(`Error: Invoking ${controller} failed.\n\n${err}`);
      });
  };

  const sendToController = (address, targetMethod, data) => {
    const url = `${address}/${controller}/${targetMethod}`;
    const payload = data ? data.toJS() : null;
    return axios.post(url, payload)
      .catch((err) => {
        console.error(`Error: Sending data to ${controller} failed.\n\n${err}`);
      });
  };

  function accessTokenFactory() {
    return (dispatch, getState) => {
      const state = getState();
      return getValueFromState(state, accessToken);
    };
  }

  class InjectSignalR extends React.PureComponent {
    static WrappedComponent = WrappedComponent;

    constructor(props) {
      super(props);
      this.state = {
        hub: null,
        pending: undefined,
        active: undefined,
        moribund: undefined,
        retry: 0,
        create: 0,
      };
    }

    componentWillMount() {
      // console.debug(`${InjectSignalR.displayName}.componentWillMount`);
      this.hubProxy = {
        invoke: this.invoke,
        send: this.send,
        connectionId: undefined,
        register: this.registerListener,
        unregister: this.unregisterListener,
      };
    }

    componentDidMount() {
      // console.debug(`${InjectSignalR.displayName}.componentDidMount`);
      this.createHub();
    }

    componentWillUpdate(nextProps, nextState) {
      if (this.state.hub !== nextState.hub) {
        // console.debug(`${InjectSignalR.displayName}.componentWillUpdate => hub`);
        if (this.state.hub) this.stopHub(this.state.hub, false);
        if (nextState.hub) this.startHub(nextState.hub);
        else this.createHub(nextState.create);
      } else if (!nextState.hub) {
        this.createHub(nextState.create);
      } else {
        let { pending, moribund } = nextState;
        if (!moribund) {
          moribund = this.moribund || Map();
        } else if (this.moribund) {
          moribund = moribund.mergeDeep(this.moribund);
        }
        const moribundCount = moribund.reduce(this.count, 0);
        if (moribundCount) {
          // console.debug(`${InjectSignalR.displayName}
          //   .componentWillUpdate => moribund [${moribundCount}]`);
          this.moribund = this.inactivateListeners(this.state.hub, moribund);
        }
        if (!pending) {
          pending = this.pending || Map();
        } else if (this.pending) {
          pending = pending.mergeDeep(this.pending);
        }
        const pendingCount = pending.reduce(this.count, 0);
        if (pendingCount) {
          // console.debug(`${InjectSignalR.displayName}
          //   .componentWillUpdate => pending [${pendingCount}]`);
          this.pending = this.activateListeners(nextState.hub, pending);
        }
      }
    }

    componentWillUnmount() {
      // console.debug(`${InjectSignalR.displayName}.componentWillUnmount`);
      this.stopHub(this.state.hub, true);
    }

    count = (c, s) => c + s.count();

    async createHub(curCreate) {
      // console.debug(`${InjectSignalR.displayName}.createHub`);
      const { retry, create } = this.state;
      if (retry > retries) {
        console.error(`Error: Ran out of retries for starting ${hubName}!`);
        this.setState({ retry: 0, create: 0 });
      } else {
        const { baseUrl, signalrActions } = this.props;
        if (baseUrl && hubName) {
          let hubAddress = baseUrl;
          if (signalrPath) hubAddress = `${hubAddress}/${signalrPath}`;
          hubAddress = `${hubAddress}/${hubName}`;
          this.token = signalrActions.accessTokenFactory();
          if (this.token) {
            if (this.oldToken === this.token) {
              if ((curCreate || create) > retries) {
                console.warn('Warning: Unable to get up-to-date access token.');
              } else {
                this.setState({ hub: null, create: (curCreate || create) + 1 });
              }
              return;
            }
            this.oldToken = undefined;
          }
          const hub = new HubConnectionBuilder()
            .withUrl(hubAddress, {
              transport: HttpTransportType.WebSockets,
              accessTokenFactory: () => this.token,
            })
            .build();
          hub.onclose = this.handleError;
          this.setState({ hub, retry: retry + 1, create: 0 });
        }
      }
    }

    startHub(hub) {
      // console.debug(`${InjectSignalR.displayName}.startHub`);
      if (hub) {
        hub.start()
          .then(() => {
            const { pending, active } = this.state;
            if (!this.pending) this.pending = pending || Map();
            if (!this.active) this.active = active || Map();
            this.setState({ active: this.active, pending: this.pending, retry: 0 });
          })
          .catch((err) => {
            console.warn(`Warning: Error while establishing connection to hub ${hubName}.\n\n${err}`);
            hub.stop();
            this.handleError(err);
          });
      }
    }

    handleError = (err) => {
      const { response, statusCode } = err;
      const { status } = response || {};
      switch (status || statusCode) {
        case 500: break;
        case 401: this.oldToken = this.token; // fall through
        default: this.setState({ hub: null }); break;
      }
    }

    stopHub(hub, clear) {
      // console.debug(`${InjectSignalR.displayName}.stopHub`);
      if (hub) {
        if (clear) {
          // Clear pending
          this.pending = undefined;
          // Merge active to pending
        } else if (!this.pending) {
          this.pending = this.state.active;
        } else if (this.state.active) {
          this.pending = this.pending.mergeDeep(this.state.active);
        }
        hub.stop();
        this.active = undefined;
        this.setState({ pending: this.pending, active: this.active });
      }
    }

    registerListener = (name, handler) => {
      // console.debug(`${InjectSignalR.displayName}
      //   .registerListener(${name}, ${handler.name || '<handler>'}(...))`);
      const { pending, active, moribund } = this.state;
      // Remove listener from moribund listeners
      if (!this.moribund) this.moribund = moribund || Map();
      const existingMoribund = this.moribund.getIn([name], Set());
      if (existingMoribund.has(handler)) {
        const remainingMoribund = existingMoribund.filterNot(h => h === handler);
        this.moribund = remainingMoribund.size
          ? this.moribund.setIn([name], remainingMoribund) : this.moribund.delete(name);
      }
      // Add listener to pending listeners (if it is NOT active)
      if (!this.active) this.active = active || Map();
      const existingActive = this.active.getIn([name], Set());
      if (!existingActive.has(handler)) {
        if (!this.pending) this.pending = pending || Map();
        const existingPending = this.pending.getIn([name], Set());
        if (!existingPending.has(handler)) {
          this.pending = this.pending.setIn([name], existingPending.add(handler));
        }
      }
      if (this.pending !== pending || this.moribund !== moribund) {
        this.setState({ pending: this.pending, moribund: this.moribund });
      }
    }

    unregisterListener = (name, handler) => {
      // console.debug(`${InjectSignalR.displayName}
      //   .unregisterListener(${name}, ${handler.name || '<handler>'}(...))`);
      const { pending, active, moribund } = this.state;
      // Remove listener from pending listeners
      if (!this.pending) this.pending = pending || Map();
      const existingPending = this.pending.getIn([name], Set());
      if (existingPending.has(handler)) {
        const remainingPending = existingPending.filterNot(h => h === handler);
        this.pending = remainingPending.count()
          ? this.pending.setIn([name], remainingPending)
          : this.pending.delete(name);
      }
      // Add listener to moribund listeners (if it is active)
      if (!this.active) this.active = active || Map();
      const existingActive = this.active.getIn([name], Set());
      if (existingActive.has(handler)) {
        if (!this.moribund) this.moribund = moribund || Map();
        const existingMoribund = this.moribund.getIn([name], Set());
        if (!existingMoribund.has(handler)) {
          this.moribund = this.moribund.setIn([name], existingMoribund.add(handler));
        }
      }
      if (this.pending !== pending || this.moribund !== moribund) {
        this.setState({ pending: this.pending, moribund: this.moribund });
      }
    }

    activateListeners(hub, pendingParam) {
      // console.debug(`${InjectSignalR.displayName}
      //   .activateListeners([${(pending ? pending.reduce(this.count, 0) : 0)}])`);
      let pending = pendingParam;
      if (hub && pendingParam) {
        const { connection } = hub;
        if (connection && connection.connectionState === 1) {
          const { active } = this.state;
          if (!this.active) this.active = active || Map();
          if (this.active.reduce(this.count, 0)) {
            pending = pending.mapEntries(([name, curHandlers]) => {
              const existing = this.active.getIn([name]);
              const handlers = existing
                ? curHandlers.filterNot(handler => existing.has(handler))
                : curHandlers;
              return [name, handlers];
            });
          }
          pending.mapEntries(([name, handlers]) =>
            handlers.map(handler => hub.on(name, handler)));
          this.active = this.active.mergeDeep(pending);
          this.setState({ pending: undefined, active: this.active });
          return undefined;
        }
      }
      return pending;
    }

    inactivateListeners(hub, moribund) {
      // console.debug(`${InjectSignalR.displayName}
      //   .inactivateListeners([${(moribund ? moribund.reduce(this.count, 0) : 0)}])`);
      if (hub && moribund) {
        moribund.mapEntries(([name, handlers]) =>
          handlers.map(handler => hub.off(name, handler)));
        const { active } = this.state;
        if (!this.active) this.active = active || Map();
        this.active = this.active.mapEntries(([name, curHandlers]) => {
          const removable = moribund.getIn([name]);
          const handlers = removable
            ? curHandlers.filterNot(handler => removable.has(handler))
            : curHandlers;
          return [name, handlers];
        });
        this.setState({ active: this.active, moribund: undefined });
        return undefined;
      }
      return moribund;
    }

    invoke = (target, data) => {
      invokeController(this.props.baseUrl, target, data);
    }

    send = (target, data) => {
      sendToController(this.props.baseUrl, target, data);
    }

    render() {
      const { baseUrl, signalrActions, ...passThroughProps } = this.props;
      const hubProp = { [hubName]: this.hubProxy };
      return (
        <WrappedComponent
          {...passThroughProps}
          {...hubProp}
        />
      );
    }
  }

  InjectSignalR.displayName = `InjectSignalR(${getDisplayName(WrappedComponent)})`;

  InjectSignalR.propTypes = {
    baseUrl: PropTypes.string.isRequired,
    signalrActions: PropTypes.shape({
      getAccessToken: PropTypes.func,
    }).isRequired,
  };

  const mapDispatchToProps = dispatch => ({
    signalrActions: bindActionCreators({ accessTokenFactory }, dispatch),
  });

  const mapStateToProps = (state) => {
    const baseUrl = getValueFromState(state, baseAddress);
    return { baseUrl };
  };

  return connect(mapStateToProps, mapDispatchToProps)(InjectSignalR);
}
