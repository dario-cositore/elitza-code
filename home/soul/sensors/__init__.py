from soul.sensors.hub import SensorHub
from soul.sensors.core import (
    CPUMemorySensor, DiskSensor, NetworkSensor,
    ProcessSensor, TemperatureSensor, BatterySensor,
)
from soul.sensors.filesystem import FileChangeSensor, ClipboardSensor, GitSensor
from soul.sensors.input import (
    KeyboardActivitySensor, MouseSensor,
    ScreenActivitySensor, ScreenCaptureSensor,
)
from soul.sensors.applications import (
    BrowserSensor, EmailSensor, MusicSensor,
    NotificationSensor, DockerSensor, SystemdSensor,
)
from soul.sensors.advanced import (
    USBSensor, BluetoothSensor, AudioSensor,
    LocationSensor, WeatherSensor,
)
