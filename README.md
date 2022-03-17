# Iztiar

## iztiar-broker

___iztiar-broker___ module provides a MQTT message broker to the Izitar family architecture.

It is still rather simple at the moment, but, its first goal was to demonstrate the implentation of a daemon feature as a plugin.

From development point of view, and because ___iztiar-broker___ receives the full featureApi object at initialization time, it is able to take advantage of all resources (classes, interfaces, and so on) provided by the `@iztiar/iztiar-core` core module.

### MQTT message broker

It is based on [Aedes](https://github.com/moscajs/aedes).
